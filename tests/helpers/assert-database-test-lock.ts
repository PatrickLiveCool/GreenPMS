if (process.env.QINTOPIA_DATABASE_TEST_LOCK_HELD !== "1") {
  process.stderr.write(
    "[test-suite-lock] private *:run script refused: use test:integration, test:contract, or test:e2e\n"
  );
  process.exitCode = 78;
}
