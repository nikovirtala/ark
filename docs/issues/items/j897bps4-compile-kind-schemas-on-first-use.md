# Compile kind schemas on first use

## Goal
Stop compiling every event-data schema when a kind module loads, so the adr and issues CLIs and their git hooks start faster.

## Notes
- `compileKind` in `packages/ledger/src/envelope/kind.ts` compiles every event type's schema with ajv when the kind is defined.
- At e5fe532 the built issues CLI started in 154ms and adr in 130ms, against 23ms for bare node. Importing the issues kind alone took 122ms, importing ajv 47ms, and a CPU profile of `issues --help` put 195ms of samples in ajv.
- The tests spawn the built CLIs about 2,000 times, and every git hook runs one.
- Options: compile a type's validator on first validation, import ajv lazily, or precompile with ajv's standalone code at build time. A bad schema has to stay an error that tests catch.

## Done when
- `issues --help` and `adr --help` start at least 50ms faster, measured on the same machine before and after.
- A kind whose schema does not compile still fails a test.
- The PR closes this issue with the startup times before and after.
