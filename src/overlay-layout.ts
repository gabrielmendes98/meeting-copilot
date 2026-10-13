type Bounds = { x: number; y: number; width: number; height: number };

/** Keep the complete panel reachable, including displays with negative origins. */
export function constrainOverlay(bounds: Bounds, workArea: Bounds): Bounds {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  return {
    width, height,
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height),
  };
}
