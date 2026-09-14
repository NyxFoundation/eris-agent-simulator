# Running the test suite

Use the same prerequisites as CI, including the Python SDK even when writing a TypeScript agent:

```bash
npm ci
npm run build:contracts
(cd deployer && forge build)
python3 -m venv .venv
.venv/bin/python -m pip install --require-hashes -r sdk-py/requirements.lock
.venv/bin/python -m pip install --no-deps -e sdk-py
export ERIS_PYTHON="$PWD/.venv/bin/python"
npm test
```

`npm test` limits concurrent test files to four. The suite launches real Python processes, Node
workers and local RPC servers; running one test process per available core left short startup and
compile budgets competing with all those children (#122). This bounds the default workload on
large hosts while retaining parallel tests. Runtime decision/compile timeouts and tests that kill
stuck processes are unchanged. Use a direct venv interpreter to avoid adding a version-manager shim
to each Python startup. If Foundry is absent, integration tests can skip; install it to check them.

To reproduce scheduling-dependent failures, record Node/Python/OS versions and repeat both commands
three times, saving each run's output:

```bash
npm test
node --import tsx --test test/*.test.ts   # Node's uncapped default file concurrency
```

Look at the failure itself: missing compiled contracts, missing Python packages and a sandbox that
cannot bind localhost are setup failures, not timing regressions. Do not increase a production
limit to accommodate a loaded test machine.
