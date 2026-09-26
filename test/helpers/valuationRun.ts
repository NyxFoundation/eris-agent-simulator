// Drive an adapter's staged valuation (issue #41) without a chain.
//
// Each read is answered by what it asks for -- contract, function, arguments -- rather than by its
// position in the stage, so a fixture keeps answering the right question when a stage gains a read.
import type {
  AgentProtocolValue,
  ValuationRead,
  ValuationRun,
} from "@eris/sdk/protocols/types.js";

export type ReadAnswer = (read: ValuationRead) => unknown;

export async function driveValuation(
  run: ValuationRun,
  answer: ReadAnswer,
): Promise<{
  stages: ValuationRead[][];
  values: Record<string, AgentProtocolValue>;
}> {
  const stages: ValuationRead[][] = [];
  let step = await run.next();
  while (!step.done) {
    stages.push(step.value);
    step = await run.next(step.value.map(answer));
  }
  return { stages, values: step.value };
}
