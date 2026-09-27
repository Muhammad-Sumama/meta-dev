/**
 * Measures export-alpha edge accuracy on the demo clip against full-resolution
 * ground truth (tests/fixtures/street-scene-gt-full.json):
 *
 *   npm run eval:edges
 *
 * For each subject and sampled frame it builds the export alpha from a
 * 512×288 mask — (a) the ground truth itself, downsampled (isolates the
 * upscaling error), and (b) the mock tracker's mask — with and without
 * guided-filter edge refinement, and reports the mean alpha error within 3 px
 * of the true boundary plus IoU at full resolution.
 */
import { evaluateEdges } from "../tests/helpers/evalEdges";

evaluateEdges({ verbose: true })
  .then((rows) => {
    for (const r of rows) {
      console.log(
        `${r.source.padEnd(8)} ${r.subject.padEnd(16)} edge error ${r.baseline.edgeError.toFixed(3)} → ${r.refined.edgeError.toFixed(3)}   IoU ${r.baseline.iou.toFixed(3)} → ${r.refined.iou.toFixed(3)}`,
      );
    }
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
