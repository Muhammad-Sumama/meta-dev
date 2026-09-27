/** Export edge refinement vs full-resolution ground truth on the demo clip (see scripts/eval-edges.ts). */
import { describe, expect, it } from "vitest";
import { evaluateEdges } from "../helpers/evalEdges";

describe("export edge refinement (regression)", () => {
  it("moves export edges closer to the true boundary for every demo subject", async () => {
    const rows = await evaluateEdges();
    expect(rows).toHaveLength(8); // 4 subjects × (ground-truth mask, tracked mask)
    for (const r of rows) {
      expect(r.refined.edgeError, `${r.source} ${r.subject}`).toBeLessThan(r.baseline.edgeError);
      expect(r.refined.iou, `${r.source} ${r.subject}`).toBeGreaterThanOrEqual(r.baseline.iou - 0.002);
    }
    const meanDrop = rows.reduce((a, r) => a + r.baseline.edgeError - r.refined.edgeError, 0) / rows.length;
    const meanIouGain = rows.reduce((a, r) => a + r.refined.iou - r.baseline.iou, 0) / rows.length;
    expect(meanDrop).toBeGreaterThan(0.05);
    expect(meanIouGain).toBeGreaterThan(0.03);
  }, 240_000);
});
