/**
 * Measures mock-provider quality on the demo clip against ground truth
 * (tests/fixtures/street-scene-gt.json, produced by generate-demo.ts).
 *
 *   npm run eval:mock
 *
 * Runs the same path as an AI command: rule parser → grounding → keyframe
 * segmentation → bidirectional tracking, then reports per-subject IoU.
 */
import { evaluateDemo } from "../tests/helpers/evalDemo";

evaluateDemo({ verbose: true })
  .then((report) => {
    for (const r of report) {
      console.log(
        `${r.subject.padEnd(16)} "${r.command}"  keyframe=${r.keyframe}  meanIoU=${r.meanIoU.toFixed(3)}  minIoU=${r.minIoU.toFixed(3)} @${r.worstFrame}`,
      );
    }
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
