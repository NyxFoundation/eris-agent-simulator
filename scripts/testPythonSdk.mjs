import { execFileSync } from "node:child_process";
import { delimiter, resolve } from "node:path";

execFileSync(process.env.ERIS_PYTHON ?? "python3", ["-m", "unittest", "discover", "-s", "sdk-py/tests"], {
  stdio: "inherit",
  env: {
    ...process.env,
    PYTHONPATH: [resolve("sdk-py"), process.env.PYTHONPATH].filter(Boolean).join(delimiter),
  },
});
