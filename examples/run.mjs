// Reproduces the README example without a TypeSafe key: runs cache-boundary on the made-up saved responses in
// examples/site and answers every question from the hand-written probabilities in fixture-answers.json.
// Nothing leaves the machine.
//   node examples/run.mjs              the report (examples/report.txt)
//   node examples/run.mjs --json       the JSON (examples/report.json)
//   node examples/run.mjs --dry-run    the dry run (examples/dry-run.txt)
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main } from "../src/cli.mjs";
import { fixtureFetch } from "../src/jev.mjs";
import { estimateTokens } from "../src/questions.mjs";

export const SITE = fileURLToPath(new URL("./site", import.meta.url));
const FIXTURE = JSON.parse(readFileSync(new URL("./fixture-answers.json", import.meta.url), "utf8"));

/** A choice answer shaped like TypeSafe's, with the confidence approximation from TypeSafe's confidence page. */
export function choiceAnswer(probabilities) {
  const options = Object.keys(probabilities);
  const total = Object.values(probabilities).reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 0.001) throw new Error(`Fixture probabilities for ${options.join(", ")} add up to ${total}.`);
  const choice = options.reduce((best, option) => (probabilities[option] > probabilities[best] ? option : best));
  const k = options.length;
  const confidence = Math.min(1, Math.max(0, (k * probabilities[choice] - 1) / (k - 1)));
  return { type: "choice", choice, probabilities, confidence: Math.round(confidence * 100) / 100 };
}

/** A fetch stand-in that answers from fixture-answers.json, choosing the answers by the page path in the state. */
export function exampleFetch() {
  return fixtureFetch((body) => {
    const fixture = FIXTURE.answers[body.state.page.path];
    if (!fixture) throw new Error(`No fixture answer for ${body.state.page.path}.`);
    return {
      model: FIXTURE.model,
      answers: {
        visitor_content: { type: "noul", noul: fixture.visitor_content },
        private_token: { type: "noul", noul: fixture.private_token },
        cache_rule: choiceAnswer(fixture.cache_rule),
      },
      usage: { input_tokens: estimateTokens(JSON.stringify(body)), output_tokens: 0 },
    };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flags = process.argv.slice(2).filter((flag) => flag === "--json" || flag === "--dry-run");
  process.exitCode = await main([SITE, ...flags], {
    env: { TYPESAFE_API_KEY: "fixture" },
    fetchImpl: exampleFetch().fetchImpl,
  });
}
