import Foundation

// Core test runner: the only file in CoreTests with top-level code. Run with CoreTests/run.sh.

runImpactTests()
runQuickAddTests()
runTimePlanTests()
runTimesTests()
runAccessTests()
runOverviewTests()
runJevTests()
runWebhooksTests()
runFormatTests()
runTaskTextTests()
runParityTests()

let total = TestRun.passed + TestRun.failedTests
if TestRun.failedTests == 0 {
    print("✓ \(total) tests passed, 0 failed (\(parityComparisons) TypeScript parity comparisons)")
    exit(0)
} else {
    print("✗ \(TestRun.failedTests) of \(total) tests failed (\(TestRun.failures) failed expectations)")
    exit(1)
}
