#!/usr/bin/env python3
"""Build a local, paired sql.js runtime; never installs into the application."""

import argparse
import hashlib
import io
import json
import os
import platform
import re
import shlex
import shutil
import signal
import ssl
import stat
import subprocess
import sys
import tarfile
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath


SQLJS_COMMIT = "9c4e167ec37129192d166ab9223faa9a4bd07c58"
EMSDK_COMMIT = "b4258c35121c8d0e12f53568ffb22236d7816723"
COMPILER_BUILD = "e44d3cc557d78155966478aa2bd8dec657609619"
SQLITE_VERSION = "3.53.4"
SQLITE_DIR = "sqlite-amalgamation-3530400"
SQLITE_SOURCE_ID = (
    "2026-07-24 19:02:57 "
    "bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc"
)
SQLITE_C_SHA3 = "67f423e9ebbbdc473cbc4772c872ee6b89f31fde4ed0279a5c25d5f65c043a16"
NODE_VERSION = "24.21.0"
CLOSURE_VERSION = "20240317.0.0"
# This archive has no independently verified publisher checksum. A recorded
# TLS-acquired digest is a repeat-download pin, not an independent attestation.
EMSCRIPTEN_SHA256 = "ba97bdf3737d19f70af390223eb6262013b89206202779b6a8d57568b3241a59"
ACQUIRED_SHA256 = {
    "sqljs": "c85fa106ff13c4d58ac2a401e35260307e3344dc8e4a6ac40778a22d256c7b09",
    "emsdk_releases": "2fa7b2d5e7bc3f3597ffe8a7901051b705b050eae0c731c866d3d96ff1c51671",
    "emsdk_installer": "02ec9773aed0c7651777d610af46b1fc44c7a13f46f3f4c5767b8e8d6bca442f",
}

INPUTS = {
    "sqljs": {
        "url": f"https://codeload.github.com/sql-js/sql.js/tar.gz/{SQLJS_COMMIT}",
        "file": "sqljs-source.tar.gz",
        "limit": 32 * 1024 * 1024,
    },
    "emsdk_releases": {
        "url": (
            "https://raw.githubusercontent.com/emscripten-core/emsdk/"
            f"{EMSDK_COMMIT}/emscripten-releases-tags.json"
        ),
        "file": "emsdk-releases.json",
        "limit": 1024 * 1024,
    },
    "emsdk_installer": {
        "url": (
            "https://raw.githubusercontent.com/emscripten-core/emsdk/"
            f"{EMSDK_COMMIT}/emsdk.py"
        ),
        "file": "emsdk.py",
        "limit": 1024 * 1024,
    },
    "sqlite": {
        "url": f"https://www.sqlite.org/2026/{SQLITE_DIR}.zip",
        "file": f"{SQLITE_DIR}.zip",
        "sha3_256": "628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e",
        "limit": 8 * 1024 * 1024,
    },
    "extension": {
        "url": "https://www.sqlite.org/contrib/download/extension-functions.c?get=25",
        "file": "extension-functions.c",
        "sha256": "991b40fe8b2799edc215f7260b890f14a833512c9d9896aa080891330ffe4052",
        "limit": 1024 * 1024,
    },
    "node_checksums": {
        "url": f"https://nodejs.org/dist/v{NODE_VERSION}/SHASUMS256.txt",
        "file": "node-SHASUMS256.txt",
        "limit": 1024 * 1024,
    },
    "node": {
        "url": (
            f"https://nodejs.org/dist/v{NODE_VERSION}/"
            f"node-v{NODE_VERSION}-linux-x64.tar.gz"
        ),
        "file": f"node-v{NODE_VERSION}-linux-x64.tar.gz",
        "sha256": "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
        "limit": 100 * 1024 * 1024,
    },
    "emscripten": {
        "url": (
            "https://storage.googleapis.com/webassembly/emscripten-releases-builds/"
            f"linux/{COMPILER_BUILD}/wasm-binaries.tar.xz"
        ),
        "file": "wasm-binaries.tar.xz",
        "bytes": 350259396,
        "limit": 350259396,
    },
}
ALLOWED_HOSTS = {
    urllib.parse.urlsplit(item["url"]).hostname for item in INPUTS.values()
}
MARKER = "isolated-sqljs-runtime-build-v1"
MIN_FREE_BYTES = 12 * 1024**3
DRIVER_SOURCE = Path(__file__).read_bytes()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path, algorithm="sha256"):
    h = hashlib.new(algorithm)
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def safe_member(name):
    require(
        isinstance(name, str)
        and name
        and not any(ch in name for ch in ("\\", "\0", ":")),
        "Invalid archive member name",
    )
    path = PurePosixPath(name)
    require(not path.is_absolute() and ".." not in path.parts, "Archive path escape")
    require(path.parts and path.parts[0] not in ("", "."), "Empty archive member")
    return path


def safe_link(member, target, hard=False):
    require(
        target
        and not any(ch in target for ch in ("\\", "\0", ":"))
        and not PurePosixPath(target).is_absolute(),
        "Absolute or invalid archive link",
    )
    parts = [] if hard else list(member.parent.parts)
    for component in PurePosixPath(target).parts:
        if component == "..":
            require(bool(parts), "Archive link escape")
            parts.pop()
        elif component not in ("", "."):
            parts.append(component)
    require(parts and parts[0] == member.parts[0], "Archive link leaves top-level root")
    return PurePosixPath(*parts)


def extract_archive(archive, destination, max_bytes=8 * 1024**3):
    """Create files before links; reject devices, traversal and link ancestors."""
    require(not destination.exists(), "Extraction destination must not exist")
    destination.mkdir(mode=0o700)
    entries = []
    if archive.suffix == ".zip":
        container = zipfile.ZipFile(archive)
        for entry in container.infolist():
            member = safe_member(entry.filename)
            mode = entry.external_attr >> 16
            require(not stat.S_ISLNK(mode), "ZIP symlinks are not supported")
            require(
                not stat.S_IFMT(mode) or stat.S_ISDIR(mode) or stat.S_ISREG(mode),
                "Special ZIP member",
            )
            kind = "dir" if entry.is_dir() else "file"
            entries.append((member, kind, mode, entry.file_size, entry, None))
    else:
        container = tarfile.open(archive, "r:*")
        for entry in container.getmembers():
            member = safe_member(entry.name)
            if entry.isdir():
                kind = "dir"
            elif entry.isfile():
                kind = "file"
            elif entry.issym():
                kind = "symlink"
            elif entry.islnk():
                kind = "hardlink"
            else:
                raise RuntimeError("Special TAR member")
            link = None
            if kind in ("symlink", "hardlink"):
                link = safe_link(member, entry.linkname, kind == "hardlink")
            entries.append((member, kind, entry.mode, entry.size, entry, link))
    with container:
        require(sum(entry[3] for entry in entries) <= max_bytes, "Archive too large")
        names = {}
        for member, kind, *_ in entries:
            require(member not in names, "Duplicate archive path")
            names[member] = kind
        for member in names:
            for parent in member.parents:
                require(
                    names.get(parent, "dir") == "dir",
                    "Archive has a non-directory ancestor",
                )
        for member, kind, mode, _, entry, _ in entries:
            output = destination.joinpath(*member.parts)
            if kind == "dir":
                output.mkdir(parents=True, exist_ok=True, mode=0o700)
            elif kind == "file":
                output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                source = (
                    container.open(entry)
                    if isinstance(container, zipfile.ZipFile)
                    else container.extractfile(entry)
                )
                with source, output.open("xb") as stream:
                    shutil.copyfileobj(source, stream, 1024 * 1024)
                output.chmod(0o755 if mode & 0o111 else 0o644)
        for member, kind, _, _, entry, link in entries:
            if kind not in ("symlink", "hardlink"):
                continue
            output = destination.joinpath(*member.parts)
            target = destination.joinpath(*link.parts)
            require(
                target.resolve().is_relative_to(destination.resolve()),
                "Resolved archive link escape",
            )
            output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if kind == "hardlink":
                require(names.get(link) == "file", "Hardlink must target a regular file")
                os.link(target, output)
            else:
                os.symlink(entry.linkname, output)
        for member, kind, *_ in entries:
            if kind == "symlink":
                output = destination.joinpath(*member.parts)
                require(output.exists(), "Dangling or circular archive link")
                require(
                    output.resolve().is_relative_to(destination.resolve()),
                    "Resolved archive link escape",
                )


class HTTPSOnlyRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        require(
            parsed.scheme == "https"
            and parsed.hostname in ALLOWED_HOSTS
            and not parsed.username
            and not parsed.password,
            "Unexpected download redirect",
        )
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def download(name, downloads, old_records):
    spec = INPUTS[name]
    output = downloads / spec["file"]
    expected = {key: spec[key] for key in ("sha256", "sha3_256") if key in spec}
    if name == "emscripten" and EMSCRIPTEN_SHA256:
        expected["sha256"] = EMSCRIPTEN_SHA256
    if name in ACQUIRED_SHA256:
        expected["sha256"] = ACQUIRED_SHA256[name]
    prior = old_records.get(name)
    if prior:
        expected.setdefault("sha256", prior["sha256"])
    if not output.exists():
        # No ambient proxy/auth configuration or insecure-TLS fallback.
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            HTTPSOnlyRedirect(),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        )
        partial = output.with_name(output.name + ".partial")
        require(not partial.exists(), "Incomplete download exists; inspect it before retrying")
        print(f"Downloading {name}", flush=True)
        request = urllib.request.Request(spec["url"], headers={"User-Agent": MARKER})
        with opener.open(request, timeout=120) as response, partial.open("xb") as stream:
            total = 0
            milestone = 0
            for chunk in iter(lambda: response.read(1024 * 1024), b""):
                total += len(chunk)
                require(total <= spec["limit"], f"{name} download exceeds size limit")
                stream.write(chunk)
                if total // (64 * 1024 * 1024) > milestone:
                    milestone = total // (64 * 1024 * 1024)
                    print(f"  {name}: {total // (1024 * 1024)} MiB", flush=True)
        for algorithm, value in expected.items():
            require(digest(partial, algorithm) == value, f"{name} {algorithm} mismatch")
        require(
            "bytes" not in spec or partial.stat().st_size == spec["bytes"],
            f"{name} byte count mismatch",
        )
        partial.rename(output)
    require(output.is_file() and not output.is_symlink(), "Input must be a regular file")
    for algorithm, value in expected.items():
        require(digest(output, algorithm) == value, f"{name} {algorithm} mismatch")
    require(
        output.stat().st_size <= spec["limit"]
        and ("bytes" not in spec or output.stat().st_size == spec["bytes"]),
        f"{name} cached byte count mismatch",
    )
    return {
        "url": spec["url"],
        "file": f"downloads/{spec['file']}",
        "bytes": output.stat().st_size,
        "sha256": digest(output),
        **({"sha3_256": digest(output, "sha3_256")} if name == "sqlite" else {}),
        "verification": (
            "pre-verified pinned input digest (HTTPS retrieval; publisher signatures not verified)"
            if "sha256" in spec or "sha3_256" in spec
            else "HTTPS acquisition; locally observed digest, not independent publisher attestation"
        ),
    }


def private_env(root, state, node=None, emscripten=None):
    for name in ("home", "cache", "npm-cache", "scratch"):
        (state / name).mkdir(parents=True, exist_ok=True, mode=0o700)
    npmrc = state / "npmrc"
    npmrc.write_text("audit=false\nfund=false\nupdate-notifier=false\n", encoding="utf-8")
    env = {
        "PATH": f"{node.parent}:/usr/bin:/bin" if node else "/usr/bin:/bin",
        "HOME": str(state / "home"),
        "XDG_CACHE_HOME": str(state / "cache"),
        "TMPDIR": str(state / "scratch"),
        "TMP": str(state / "scratch"),
        "TEMP": str(state / "scratch"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TZ": "UTC",
        "SOURCE_DATE_EPOCH": "1784919777",
        "PYTHONHASHSEED": "0",
        "PYTHONDONTWRITEBYTECODE": "1",
        "npm_config_userconfig": str(npmrc),
        "npm_config_globalconfig": str(npmrc),
        "npm_config_cache": str(state / "npm-cache"),
        "npm_config_audit": "false",
        "npm_config_fund": "false",
        "npm_config_update_notifier": "false",
        "npm_config_ignore_scripts": "true",
        "npm_config_registry": "https://registry.npmjs.org/",
    }
    if emscripten:
        config = state / "emscripten-config.py"
        upstream = emscripten.parent
        config.write_text(
            f"LLVM_ROOT = {str(upstream / 'bin')!r}\n"
            f"BINARYEN_ROOT = {str(upstream)!r}\n"
            f"NODE_JS = [{str(node)!r}]\n"
            f"CLOSURE_COMPILER = [{str(emscripten / 'node_modules' / 'google-closure-compiler-linux' / 'compiler')!r}]\n"
            f"CACHE = {str(state / 'em-cache')!r}\n",
            encoding="utf-8",
        )
        env.update(
            {
                "EM_CONFIG": str(config),
                "EM_CACHE": str(state / "em-cache"),
                "EM_LLVM_ROOT": str(upstream / "bin"),
                "EM_BINARYEN_ROOT": str(upstream),
                "EM_NODE_JS": str(node),
                "EMCC_TEMP_DIR": str(state / "scratch"),
                "EMCC_CORES": "2",
            }
        )
    return env


def redact(text, root):
    return (
        str(text)
        .replace(str(root), "<workspace>")
        .replace(str(Path(__file__).resolve()), "<driver>")
        .replace(str(Path.home()), "<home>")
    )


def command(argv, cwd, env, root, log, timeout=900, required=True):
    started = time.monotonic()
    args = [str(arg) for arg in argv]
    timed_out = False
    with subprocess.Popen(
        args,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        errors="replace",
        start_new_session=True,
    ) as process:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
        result = subprocess.CompletedProcess(args, process.returncode, stdout, stderr)
    text = redact(result.stdout + result.stderr, root)
    log.write_text(
        "$ " + redact(shlex.join([str(arg) for arg in argv]), root) + "\n" + text,
        encoding="utf-8",
    )
    record = {
        "argv": [redact(arg, root) for arg in argv],
        "cwd": str(cwd.relative_to(root)),
        "exit_code": result.returncode,
        "timed_out": timed_out,
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "log": str(log.relative_to(root)),
    }
    require(not timed_out, f"Command exceeded {timeout}s; see {log.relative_to(root)}")
    if required and result.returncode:
        raise RuntimeError(
            f"Command failed ({result.returncode}); see {log.relative_to(root)}\n{text[-2500:]}"
        )
    return result, record


def host_checks(root):
    require(platform.system() == "Linux", "Run inside existing Linux/WSL, not Windows Python")
    require(platform.machine() == "x86_64", "Only the pinned Linux x86_64 tools are qualified")
    require(sys.version_info >= (3, 10), "Python 3.10 or later is required")
    import lzma  # noqa: F401
    import zlib  # noqa: F401

    require(Path("/lib64/ld-linux-x86-64.so.2").is_file(), "Linux x86_64 loader missing")
    free = shutil.disk_usage(root).free
    require(free >= MIN_FREE_BYTES, "At least 12 GiB of free workspace space is required")
    os_release = {}
    if Path("/etc/os-release").exists():
        for line in Path("/etc/os-release").read_text().splitlines():
            key, _, value = line.partition("=")
            if key in ("ID", "VERSION_ID"):
                os_release[key] = value.strip('"')
    return {
        "os": "Linux",
        "machine": platform.machine(),
        "distribution": os_release,
        "kernel": platform.release(),
        "libc": list(platform.libc_ver()),
        "python": platform.python_version(),
        "tls": ssl.OPENSSL_VERSION,
        "compression": ["xz", "gzip", "zip"],
        "workspace_free_bytes_before": free,
        "preexisting_tools": {
            name: shutil.which(name) is not None
            for name in ("make", "emcc", "emmake", "node", "cmake", "unzip")
        },
    }


def extract_once(archive, destination, marker_name):
    marker = destination / marker_name
    if destination.exists():
        require(
            marker.is_file() and marker.read_text().strip() == digest(archive),
            "Existing extraction has no matching completion marker; use a new workspace",
        )
    else:
        print(f"Extracting {archive.name}", flush=True)
        extract_archive(archive, destination)
        marker.write_text(digest(archive) + "\n", encoding="utf-8")


def provision(root, manifest):
    downloads = root / "downloads"
    downloads.mkdir(exist_ok=True, mode=0o700)
    record_path = root / "input-records.json"
    records = json.loads(record_path.read_text()) if record_path.exists() else {}
    for name in INPUTS:
        records[name] = download(name, downloads, records)
        write_json(record_path, records)
    releases = json.loads((downloads / INPUTS["emsdk_releases"]["file"]).read_text())
    require(releases["releases"]["5.0.0"] == COMPILER_BUILD, "EMSDK release mapping mismatch")
    node_checksum_line = (
        INPUTS["node"]["sha256"] + "  " + INPUTS["node"]["file"]
    )
    require(
        node_checksum_line in (downloads / INPUTS["node_checksums"]["file"]).read_text().splitlines(),
        "Node publisher checksum list does not match the pinned archive",
    )
    paths = {}
    for name in ("sqljs", "node", "emscripten"):
        target = root / f"{name}-unpacked"
        extract_once(downloads / INPUTS[name]["file"], target, ".archive-complete")
        paths[name] = target
    source = paths["sqljs"] / f"sql.js-{SQLJS_COMMIT}"
    node = paths["node"] / f"node-v{NODE_VERSION}-linux-x64" / "bin" / "node"
    compiler_matches = list(paths["emscripten"].glob("*/emscripten/emcc.py"))
    require(len(compiler_matches) == 1, "Unexpected Emscripten archive layout")
    emscripten = compiler_matches[0].parent
    require(
        json.loads((source / "package.json").read_text())["version"] == "1.14.2",
        "sql.js source version mismatch",
    )
    require(
        "ENV EMSCRIPTEN_VERSION 5.0.0" in (source / ".devcontainer" / "Dockerfile").read_text(),
        "sql.js source toolchain baseline mismatch",
    )
    # The release archive precedes the version bump. Reproduce the pinned SDK's
    # installation stamp (emsdk.py:2212-2220), not an invented compiler identity.
    version_file = emscripten / "emscripten-version.txt"
    stamp_file = emscripten / ".local-release-stamp.json"
    version_stamp = {
        "archive_version": "4.0.24-git",
        "installed_version": "5.0.0",
        "authority": "downloads/emsdk.py:2212-2220 and downloads/emsdk-releases.json",
    }
    if version_file.read_text() == "4.0.24-git\n":
        version_file.write_text('"5.0.0"\n', encoding="utf-8")
        write_json(stamp_file, version_stamp)
    else:
        require(
            version_file.read_text() == '"5.0.0"\n'
            and stamp_file.is_file()
            and json.loads(stamp_file.read_text()) == version_stamp,
            "Unexpected toolchain version or missing documented SDK installation stamp",
        )
    manifest["emscripten_version_stamp"] = version_stamp
    revision = (emscripten / "emscripten-revision.txt").read_text().strip()
    require(revision == "a7c5deabd7c88ba1c38ebe988112256775f944c6", "Unexpected compiler source revision")
    manifest["emscripten_source_revision"] = revision
    lock_path = emscripten / "package-lock.json"
    lock = json.loads(lock_path.read_text())
    closure = lock["packages"]["node_modules/google-closure-compiler"]
    native = lock["packages"]["node_modules/google-closure-compiler-linux"]
    require(closure["version"] == CLOSURE_VERSION, "Unexpected Closure lock version")
    require(native["version"] == CLOSURE_VERSION, "Unexpected native Closure lock version")
    manifest.update(
        {
            "inputs": records,
            "sqljs_commit": SQLJS_COMMIT,
            "emsdk_commit": EMSDK_COMMIT,
            "compiler_build": COMPILER_BUILD,
            "source_makefile_sha256": digest(source / "Makefile"),
            "exported_functions_sha256": digest(source / "src" / "exported_functions.json"),
            "exported_runtime_methods_sha256": digest(source / "src" / "exported_runtime_methods.json"),
            "emscripten_package_lock_sha256": digest(lock_path),
            "closure_locked_packages": {"compiler": closure, "linux": native},
        }
    )
    state = root / "provision-state"
    env = private_env(root, state, node, emscripten)
    logs = root / "logs"
    logs.mkdir(exist_ok=True)
    manifest["provision_commands"] = []
    for name, args in (
        ("node", [node, "--version"]),
        ("clang", [emscripten.parent / "bin" / "clang", "--version"]),
        ("wasm-opt", [emscripten.parent / "bin" / "wasm-opt", "--version"]),
    ):
        result, record = command(args, root, env, root, logs / f"{name}.txt")
        manifest["provision_commands"].append(record)
        manifest.setdefault("tool_versions", {})[name] = redact(result.stdout.strip(), root)
        if name == "node":
            require(result.stdout.strip() == f"v{NODE_VERSION}", "Node version mismatch")
    # Missing-package validation precedes the private, lock-respecting install.
    probe, record = command(
        [node, "-e", "require.resolve('google-closure-compiler'); require.resolve('acorn');"],
        emscripten, env, root, logs / "npm-probe.txt", required=False,
    )
    manifest["provision_commands"].append(record)
    if probe.returncode:
        npm = node.parent.parent / "lib" / "node_modules" / "npm" / "bin" / "npm-cli.js"
        _, record = command(
            [node, npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
            emscripten, env, root, logs / "npm-ci.txt", timeout=1200,
        )
        manifest["provision_commands"].append(record)
    require(digest(lock_path) == manifest["emscripten_package_lock_sha256"], "npm changed the lockfile")
    for name in ("google-closure-compiler", "google-closure-compiler-linux"):
        installed = json.loads((emscripten / "node_modules" / name / "package.json").read_text())
        require(installed["version"] == CLOSURE_VERSION, f"Installed {name} differs from the lock")
    closure_path = emscripten / "node_modules" / "google-closure-compiler-linux" / "compiler"
    require(closure_path.is_file(), "Locked native Closure unavailable; no Java/global-install fallback")
    result, record = command(
        [closure_path, "--version"], root, env, root, logs / "closure.txt"
    )
    manifest["provision_commands"].append(record)
    manifest["tool_versions"]["closure"] = result.stdout.strip()
    manifest["closure_binary_sha256"] = digest(closure_path)
    result, record = command(
        [sys.executable, emscripten / "emcc.py", "--version"],
        root, env, root, logs / "emcc.txt",
    )
    manifest["provision_commands"].append(record)
    manifest["tool_versions"]["emcc"] = redact(result.stdout.strip(), root)
    return source, node, emscripten


def make_flags(makefile, name):
    logical = makefile.replace("\\\n", "")
    match = re.search(r"^" + re.escape(name) + r"\s*=\s*(.*)$", logical, re.MULTILINE)
    require(match is not None, f"Missing upstream setting: {name}")
    flags = shlex.split(match.group(1))
    require(not any("$" in flag for flag in flags), "Unexpanded upstream Makefile variable")
    return flags


SMOKE_JS = r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const init = require(path.resolve('dist/sql-wasm.js'));
  const SQL = await init({wasmBinary: fs.readFileSync('dist/sql-wasm.wasm')});
  const db = new SQL.Database();
  const scalar = sql => db.exec(sql)[0].values[0][0];
  const version = scalar('select sqlite_version()');
  const sourceId = scalar('select sqlite_source_id()');
  assert.equal(version, '3.53.4');
  assert.equal(sourceId, process.argv[2]);
  const compileOptions = db.exec('pragma compile_options')[0].values.map(x => x[0]).sort();
  for (const item of ['ENABLE_FTS3', 'ENABLE_FTS3_PARENTHESIS', 'ENABLE_NORMALIZE',
                       'OMIT_LOAD_EXTENSION', 'THREADSAFE=0']) {
    assert.ok(compileOptions.includes(item), item);
  }
  assert.ok(!compileOptions.includes('ENABLE_FTS5'));
  assert.equal(scalar("select concat_ws('|', 'a', NULL, 'b', '')"), 'a|b|');
  assert.equal(scalar("select concat_ws(NULL, 'a', 'b')"), null);
  assert.equal(scalar("select concat('one',NULL,'two')"), 'onetwo');
  assert.equal(scalar("select reverse('abc')"), 'cba');
  assert.equal(scalar("select sqrt(81)"), 9);
  db.run('create virtual table search using fts3(body)');
  db.run('insert into search values (?)', ['bounded synthetic fixture']);
  assert.equal(scalar("select count(*) from search where search match 'synthetic'"), 1);
  db.run('create table smoke(id integer primary key, label text, fraction real, data blob)');
  const insert = db.prepare('insert into smoke values (?, ?, ?, ?)');
  insert.run([1, 'synthetic', 1.2345678901234567, new Uint8Array([0, 1, 254, 255])]);
  insert.free();
  db.run('begin; update smoke set label = \'changed\'; rollback;');
  assert.equal(scalar('select label from smoke'), 'synthetic');
  const rounding = scalar('select cast(fraction as text) from smoke');
  const normal = db.prepare(' SELECT 42 AS value ');
  assert.equal(normal.getNormalizedSQL(), 'SELECT?AS value;');
  normal.free();
  db.create_function('bounded_add', (a, b) => a + b);
  assert.equal(scalar('select bounded_add(2,3)'), 5);
  const bytes = db.export();
  assert.ok(bytes.length < 1024 * 1024);
  const reopened = new SQL.Database(bytes);
  assert.equal(reopened.exec('pragma integrity_check')[0].values[0][0], 'ok');
  assert.equal(reopened.exec('select fraction from smoke')[0].values[0][0],
               1.2345678901234567);
  assert.equal(reopened.exec('select hex(data) from smoke')[0].values[0][0], '0001FEFF');
  reopened.close();
  db.close();
  fs.writeFileSync('runtime-measurements.json', JSON.stringify({
    version, sourceId, compileOptions, numericToTextSample: rounding,
    benignSmoke: 'passed', exportedSyntheticBytes: bytes.length
  }, null, 2) + '\n');
})().catch(error => {console.error(error); process.exitCode = 1;});
"""


def build_one(root, index, node, emscripten, manifest):
    build = root / f"build-{index}"
    require(not build.exists(), f"build-{index} already exists; use a fresh workspace for two clean builds")
    build.mkdir(mode=0o700)
    # Separate extraction, objects, system-library cache and scratch for each build.
    extract_archive(root / "downloads" / INPUTS["sqljs"]["file"], build / "source")
    source = build / "source" / f"sql.js-{SQLJS_COMMIT}"
    extract_archive(root / "downloads" / INPUTS["sqlite"]["file"], source / "sqlite-src")
    sqlite = source / "sqlite-src" / SQLITE_DIR
    require(digest(sqlite / "sqlite3.c", "sha3_256") == SQLITE_C_SHA3, "SQLite C digest mismatch")
    shutil.copyfile(root / "downloads" / INPUTS["extension"]["file"], sqlite / "extension-functions.c")
    for name in ("out", "dist"):
        (source / name).mkdir(exist_ok=True)
    require(
        {path.name for path in (source / "dist").iterdir()} <= {".gitignore", ".npmignore"},
        "Source archive must not contain built distribution",
    )
    require(not any((source / "out").iterdir()), "Source archive must not contain prebuilt objects")
    state = build / "state"
    env = private_env(root, state, node, emscripten)
    (build / "logs").mkdir()
    makefile = (source / "Makefile").read_text()
    cflags = make_flags(makefile, "SQLITE_COMPILATION_FLAGS")
    required = {
        "-Oz", "-DSQLITE_OMIT_LOAD_EXTENSION", "-DSQLITE_DISABLE_LFS",
        "-DSQLITE_ENABLE_FTS3", "-DSQLITE_ENABLE_FTS3_PARENTHESIS",
        "-DSQLITE_THREADSAFE=0", "-DSQLITE_ENABLE_NORMALIZE",
    }
    require(set(cflags) == required and len(cflags) == len(required), "Unexpected upstream SQLite flags")
    common = make_flags(makefile, "EMFLAGS")
    optimized = make_flags(makefile, "EMFLAGS_OPTIMIZED")
    wasm = make_flags(makefile, "EMFLAGS_WASM")
    pre_js = make_flags(makefile, "EMFLAGS_PRE_JS_FILES")
    prefix_flags = [
        f"-ffile-prefix-map={root}=.",
        f"-fdebug-prefix-map={root}=.",
    ]
    compiler = [sys.executable, emscripten / "emcc.py"]
    commands = []
    print(f"Building clean runtime {index}/2", flush=True)
    for stem in ("sqlite3", "extension-functions"):
        _, record = command(
            compiler + cflags + prefix_flags
            + ["-c", f"sqlite-src/{SQLITE_DIR}/{stem}.c", "-o", f"out/{stem}.o"],
            source, env, root, build / "logs" / f"compile-{stem}.txt",
        )
        commands.append(record)
    _, record = command(
        compiler + common + optimized + wasm + prefix_flags
        + ["out/sqlite3.o", "out/extension-functions.o"] + pre_js
        + ["-o", "dist/sql-wasm.js"],
        source, env, root, build / "logs" / "link.txt", timeout=1200,
    )
    commands.append(record)
    js = source / "dist" / "sql-wasm.js"
    js.write_bytes(
        (source / "src" / "shell-pre.js").read_bytes()
        + js.read_bytes()
        + (source / "src" / "shell-post.js").read_bytes()
    )
    # The upstream WASM suite includes its worker target, also a plain concat.
    worker = source / "dist" / "worker.sql-wasm.js"
    worker.write_bytes(js.read_bytes() + (source / "src" / "worker.js").read_bytes())
    artifacts = {}
    for name in ("sql-wasm.js", "sql-wasm.wasm"):
        path = source / "dist" / name
        data = path.read_bytes()
        require(str(root).encode() not in data, "Private build prefix found in artifact")
        require(str(Path.home()).encode() not in data, "Host home found in artifact")
        # /home/web_user is upstream's fixed in-memory filesystem, not host data.
        require(
            not re.search(rb"/home/(?!web_user(?:[\"'\x00]|$))", data)
            and b"/mnt/c/" not in data,
            "Private path found in artifact",
        )
        artifacts[name] = {"sha256": digest(path), "bytes": len(data)}
    (source / "runtime-smoke.cjs").write_text(SMOKE_JS, encoding="utf-8")
    _, record = command(
        [node, "--unhandled-rejections=strict", "runtime-smoke.cjs", SQLITE_SOURCE_ID],
        source, env, root, build / "logs" / "smoke.txt", timeout=90,
    )
    commands.append(record)
    # The source-locked runner uses only Node built-ins; no sql.js npm install.
    result, record = command(
        [node, "--unhandled-rejections=strict", "test/all.js", "wasm"],
        source, env, root, build / "logs" / "upstream-wasm.txt",
        timeout=240, required=False,
    )
    commands.append(record)
    summary = re.search(r"Passed:(\d+) Failed:(\d+) Errors:(\d+)", result.stdout)
    expected_tests = len(list((source / "test").glob("test_*.js")))
    upstream = {
        "exit_code": result.returncode,
        "expected_test_count": expected_tests,
        "summary": summary.group(0) if summary else "No complete runner summary",
        "passed": bool(
            result.returncode == 0 and summary
            and int(summary.group(1)) == expected_tests
            and summary.group(2) == "0" and summary.group(3) == "0"
        ),
    }
    measured = json.loads((source / "runtime-measurements.json").read_text())
    manifest.setdefault("builds", []).append(
        {
            "name": f"build-{index}",
            "independent": "fresh source extraction, objects, EM_CACHE, HOME and scratch",
            "artifacts": artifacts,
            "commands": commands,
            "environment": {key: redact(value, root) for key, value in sorted(env.items())},
            "measurements": measured,
            "upstream_wasm_tests": upstream,
            "test_only_worker_sha256": digest(worker),
        }
    )
    manifest["flags"] = {
        "sqlite_compilation": cflags,
        "common": common,
        "optimized": optimized,
        "wasm": wasm,
        "pre_js": pre_js,
        "additional_path_remapping": ["-ffile-prefix-map=<workspace>=.", "-fdebug-prefix-map=<workspace>=."],
        "wrapper": ["src/shell-pre.js", "generated dist/sql-wasm.js", "src/shell-post.js"],
    }
    write_json(root / "provenance.json", manifest)
    require(upstream["passed"], f"Upstream WASM tests failed in build-{index}; release remains gated")
    return source / "dist"


def run(args):
    require(not args.work_dir.is_absolute(), "--work-dir must be relative to the chosen private working directory")
    require(".." not in args.work_dir.parts, "--work-dir cannot contain parent traversal")
    require(args.work_dir.parts, "--work-dir cannot be the working directory itself")
    root = args.work_dir.resolve()
    require(not args.work_dir.is_symlink(), "Workspace must not be a symlink")
    root.mkdir(mode=0o700, parents=False, exist_ok=True)
    marker = root / ".runtime-build-owner"
    if marker.exists():
        require(marker.read_text().strip() == MARKER, "Workspace belongs to another task")
    else:
        require(not any(root.iterdir()), "Workspace must be empty before ownership is recorded")
        marker.write_text(MARKER + "\n", encoding="utf-8")
    manifest = {
        "schema": 1,
        "status": "in_progress",
        "purpose": "Local candidate only; not an official sql.js release or publication authorization",
        "sqlite": {
            "version": SQLITE_VERSION,
            "source_id": SQLITE_SOURCE_ID,
            "sqlite3_c_sha3_256": SQLITE_C_SHA3,
        },
        "limitations": [
            "Toolchain archive trust starts with HTTPS, not an independently verified publisher hash or signature.",
            "Emscripten 5.0.0 matches the sql.js baseline; it is not the current toolchain or a guaranteed maintained branch.",
            "Legacy extension-functions.c is retained unchanged and is unsupported upstream.",
            "Two local clean builds are not independent-host or diverse-toolchain reproducibility.",
            "SQLite 3.53 changed numeric-to-text conversion from 15 to 17 significant digits.",
            "Application/browser/storage/cue/timestamp compatibility and independent review are parent release gates.",
            "No malicious, crash, huge-allocation, or CVE proof-of-concept payloads are executed.",
        ],
    }
    try:
        manifest["host"] = host_checks(root)
        manifest["driver_sha256"] = hashlib.sha256(DRIVER_SOURCE).hexdigest()
        _, node, emscripten = provision(root, manifest)
        write_json(root / "provenance.json", manifest)
        if args.prepare_only:
            manifest["status"] = "prepared_not_built"
        else:
            first = build_one(root, 1, node, emscripten, manifest)
            build_one(root, 2, node, emscripten, manifest)
            require(
                manifest["builds"][0]["artifacts"] == manifest["builds"][1]["artifacts"],
                "Clean-build artifact hashes differ; do not install",
            )
            require(
                manifest["builds"][0]["measurements"] == manifest["builds"][1]["measurements"],
                "Clean-build runtime measurements differ",
            )
            candidate = root / "candidate"
            require(not candidate.exists(), "Candidate directory must not already exist")
            candidate.mkdir(mode=0o700)
            for name in ("sql-wasm.js", "sql-wasm.wasm"):
                shutil.copyfile(first / name, candidate / name)
            licenses = candidate / "license-inputs"
            licenses.mkdir()
            shutil.copyfile(first.parent / "LICENSE", licenses / "sqljs-LICENSE.txt")
            shutil.copyfile(
                root / "downloads" / INPUTS["extension"]["file"],
                licenses / "extension-functions.c",
            )
            shutil.copyfile(emscripten / "LICENSE", licenses / "emscripten-LICENSE.txt")
            shutil.copyfile(
                emscripten / "system" / "lib" / "libc" / "musl" / "COPYRIGHT",
                licenses / "musl-COPYRIGHT.txt",
            )
            shutil.copyfile(
                emscripten / "system" / "lib" / "compiler-rt" / "LICENSE.TXT",
                licenses / "compiler-rt-LICENSE.txt",
            )
            manifest["license_input_sha256"] = {
                path.name: digest(path) for path in sorted(licenses.iterdir())
            }
            manifest["status"] = "two_clean_builds_match_candidate_only"
            manifest["reproducible_locally"] = True
            manifest["notices_needed"] = [
                "sql.js 1.14.2 MIT license and upstream third-party text, with custom SQLite substitution disclosed.",
                "SQLite 3.53.4 public-domain dedication and source identity.",
                "Full retained extension-functions.c header, attribution, disclaimer and unsupported status.",
                "Applicable Emscripten/LLVM/Binaryen runtime-library notices; build tools are not shipped.",
                "New paired JS/WASM hashes; do not present these as official sql.js release hashes.",
            ]
            evidence = candidate / "evidence"
            evidence.mkdir()
            for build_name in ("build-1", "build-2"):
                shutil.copytree(root / build_name / "logs", evidence / build_name)
            shutil.copytree(root / "logs", evidence / "toolchain")
            shutil.copyfile(root / "input-records.json", candidate / "input-records.json")
            manifest["evidence_sha256"] = {
                str(path.relative_to(candidate)): digest(path)
                for path in sorted(evidence.rglob("*.txt"))
            }
            write_json(candidate / "provenance.json", manifest)
            (candidate / "build-sqljs.py").write_bytes(DRIVER_SOURCE)
            print(json.dumps(manifest["builds"][0]["artifacts"], indent=2), flush=True)
        write_json(root / "provenance.json", manifest)
    except Exception as error:
        manifest["status"] = "blocked"
        manifest["blocker"] = redact(error, root)
        write_json(root / "provenance.json", manifest)
        raise


def self_test(work_dir):
    """Small extraction/Makefile tests; intentionally no compiler/network use."""
    require(not work_dir.is_absolute() and ".." not in work_dir.parts, "Use a relative self-test path")
    require(not work_dir.exists(), "Self-test directory must be new")
    work_dir.mkdir(mode=0o700)
    require(safe_member("root/file.c") == PurePosixPath("root/file.c"), "Member test failed")
    for name in ("../file", "/file", "root/../file", "C:/file", "root\\file", "x\0y"):
        try:
            safe_member(name)
        except RuntimeError:
            pass
        else:
            raise RuntimeError("Unsafe member accepted")
    require(
        safe_link(PurePosixPath("root/bin/tool"), "../lib/tool") == PurePosixPath("root/lib/tool"),
        "Safe symlink test failed",
    )
    for target in ("/etc/passwd", "../../../outside", "../../outside"):
        try:
            safe_link(PurePosixPath("root/bin/tool"), target)
        except RuntimeError:
            pass
        else:
            raise RuntimeError("Unsafe link accepted")
    archive = work_dir / "valid.tar.gz"
    with tarfile.open(archive, "w:gz") as stream:
        item = tarfile.TarInfo("root/bin/tool")
        item.mode = 0o755
        item.size = 2
        stream.addfile(item, io.BytesIO(b"ok"))
        link = tarfile.TarInfo("root/tool")
        link.type = tarfile.SYMTYPE
        link.linkname = "bin/tool"
        stream.addfile(link)
    extract_archive(archive, work_dir / "extracted")
    require((work_dir / "extracted/root/tool").read_bytes() == b"ok", "Extraction test failed")
    require(os.access(work_dir / "extracted/root/bin/tool", os.X_OK), "Executable mode lost")
    require(
        make_flags("FLAGS = -Oz \\\n -flto\nOTHER = 1\n", "FLAGS") == ["-Oz", "-flto"],
        "Makefile parser test failed",
    )
    valid_zip = work_dir / "valid.zip"
    with zipfile.ZipFile(valid_zip, "w") as stream:
        stream.writestr("root/file.txt", b"bounded")
    extract_archive(valid_zip, work_dir / "zip-extracted")
    require(
        (work_dir / "zip-extracted/root/file.txt").read_bytes() == b"bounded",
        "ZIP extraction test failed",
    )
    invalid_zip = work_dir / "traversal.zip"
    with zipfile.ZipFile(invalid_zip, "w") as stream:
        stream.writestr("../outside", b"not extracted")
    try:
        extract_archive(invalid_zip, work_dir / "zip-rejected")
    except RuntimeError:
        pass
    else:
        raise RuntimeError("ZIP traversal accepted")
    ancestor_archive = work_dir / "ancestor.tar.gz"
    with tarfile.open(ancestor_archive, "w:gz") as stream:
        link = tarfile.TarInfo("root/linked")
        link.type = tarfile.SYMTYPE
        link.linkname = "target"
        stream.addfile(link)
        item = tarfile.TarInfo("root/linked/file")
        item.size = 1
        stream.addfile(item, io.BytesIO(b"x"))
    try:
        extract_archive(ancestor_archive, work_dir / "ancestor-rejected")
    except RuntimeError:
        pass
    else:
        raise RuntimeError("Archive link ancestor accepted")
    hard_archive = work_dir / "hardlink.tar.gz"
    with tarfile.open(hard_archive, "w:gz") as stream:
        item = tarfile.TarInfo("root/file")
        item.size = 1
        stream.addfile(item, io.BytesIO(b"x"))
        link = tarfile.TarInfo("root/alias")
        link.type = tarfile.LNKTYPE
        link.linkname = "root/file"
        stream.addfile(link)
    extract_archive(hard_archive, work_dir / "hardlink-extracted")
    require(
        (work_dir / "hardlink-extracted/root/alias").read_bytes() == b"x",
        "Hardlink extraction test failed",
    )
    prior = os.environ.get("DRIVER_TEST_SECRET")
    try:
        os.environ["DRIVER_TEST_SECRET"] = "synthetic-not-a-credential"
        env = private_env(work_dir.resolve(), work_dir.resolve() / "environment")
        require("DRIVER_TEST_SECRET" not in env, "Ambient credentials were inherited")
        require(env["PATH"] == "/usr/bin:/bin", "Ambient PATH was inherited")
        require(env["npm_config_ignore_scripts"] == "true", "npm lifecycle scripts enabled")
    finally:
        if prior is None:
            del os.environ["DRIVER_TEST_SECRET"]
        else:
            os.environ["DRIVER_TEST_SECRET"] = prior
    try:
        command(
            [sys.executable, "-c", "import time; time.sleep(10)"],
            work_dir.resolve(), env, work_dir.resolve(),
            (work_dir / "bounded-timeout.txt").resolve(), timeout=0.05,
        )
    except RuntimeError as error:
        require("Command exceeded" in str(error), "Unexpected timeout result")
    else:
        raise RuntimeError("Subprocess timeout not enforced")
    print("Self-tests passed: TAR/ZIP traversal, links/ancestors, modes, Makefile flags, environment isolation")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", type=Path, required=True, help="New, private, relative workspace")
    parser.add_argument("--prepare-only", action="store_true", help="Download and qualify tools without compiling")
    parser.add_argument("--self-test", action="store_true", help="Test driver logic offline in a new directory")
    options = parser.parse_args()
    os.umask(0o077)
    try:
        if options.self_test:
            self_test(options.work_dir)
        else:
            run(options)
    except (RuntimeError, OSError, ValueError, tarfile.TarError, zipfile.BadZipFile) as error:
        print("BUILD BLOCKED: " + str(error), file=sys.stderr)
        sys.exit(1)
