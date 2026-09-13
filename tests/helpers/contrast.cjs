async function buttonContrast(button) {
  return button.evaluate(async element => {
    await Promise.all(element.getAnimations().filter(animation =>
      Number.isFinite(animation.effect.getComputedTiming().endTime)).map(animation => animation.finished));
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d");
    const rgba = color => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    };
    const blend = (foreground, background) => foreground.slice(0, 3).map((channel, index) =>
      channel * foreground[3] / 255 + background[index] * (1 - foreground[3] / 255));
    const ancestors = [];
    for (let node = element; node; node = node.parentElement) ancestors.unshift(node);
    let background = [255, 255, 255];
    for (const ancestor of ancestors) background = blend(rgba(getComputedStyle(ancestor).backgroundColor), background);
    const foreground = blend(rgba(getComputedStyle(element).color), background);
    const luminance = rgb => rgb.map(channel => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const levels = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
    return { ratio: (levels[1] + 0.05) / (levels[0] + 0.05), opacity: getComputedStyle(element).opacity };
  });
}

module.exports = { buttonContrast };
