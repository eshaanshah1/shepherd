import { describe, expect, it } from 'vitest';
import { MAX_EDGE, planDownsize } from './image-downsize.ts';

describe('planDownsize', () => {
  it('leaves an image that is already small enough alone', () => {
    expect(planDownsize(800, 600)).toEqual({ width: 800, height: 600, scale: 1 });
    // The bound is inclusive: an image exactly at the line is not re-encoded,
    // because re-encoding it would cost quality and buy nothing.
    expect(planDownsize(MAX_EDGE, 400)).toEqual({ width: MAX_EDGE, height: 400, scale: 1 });
  });

  it('scales the long edge to the bound, whichever edge that is', () => {
    expect(planDownsize(3200, 1600)).toEqual({ width: MAX_EDGE, height: 784, scale: MAX_EDGE / 3200 });
    expect(planDownsize(1600, 3200)).toEqual({ width: 784, height: MAX_EDGE, scale: MAX_EDGE / 3200 });
  });

  it('preserves the aspect ratio', () => {
    const plan = planDownsize(3024, 1964); // a Retina screenshot
    expect(plan.width).toBe(MAX_EDGE);
    expect(plan.width / plan.height).toBeCloseTo(3024 / 1964, 2);
  });

  it('never produces a zero edge', () => {
    // A canvas of width 0 throws, and an extreme panorama is the shape that
    // gets there: 4000 x 1 rounds its short edge to 0 without the clamp.
    expect(planDownsize(4000, 1).height).toBe(1);
  });
});
