// getComputedStyle on a custom property returns the raw token stream (e.g. an
// unresolved color-mix() expression, or an oklch() value on browsers that
// compute colors in that space) — lightweight-charts' color parser only
// understands hex/rgb/hsl. Painting the resolved color onto a 1x1 canvas and
// reading the pixel back forces an sRGB rgba() value it can parse.
export function cssVar(name: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.appendChild(probe);
  const specified = getComputedStyle(probe).color;
  document.body.removeChild(probe);

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = specified;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}
