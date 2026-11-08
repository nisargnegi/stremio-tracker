"""Exercise scheduling and restart behavior without network calls or Node."""
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.state = self.root / 'state'
        self.env = dict(os.environ, PATH=f'{self.bin}:' + os.environ['PATH'],
                        SCHEDULER_STATE_DIR=str(self.state), TEST_ROOT=str(self.root),
                        TEST_DAY='2026-11-07', TEST_WEEK='2026-45', FAIL_DAILY='0')
        self.command('date', 'case "$2" in +%F) echo "$TEST_DAY";; +%G-%V) echo "$TEST_WEEK";; esac')
        self.command('node', 'echo "$1" >> "$TEST_ROOT/calls"\n'
                     'if [ "$1" = src/cron.js ] && [ "$FAIL_DAILY" = 1 ]; then exit 1; fi')
        self.command('sleep', 'touch "$TEST_ROOT/sleeping"\nexec /bin/sleep 60')

    def command(self, name, source):
        path = self.bin / name
        path.write_text('#!/bin/sh\n' + source + '\n')
        path.chmod(0o755)

    def run_cycle(self):
        sleeping = self.root / 'sleeping'
        sleeping.unlink(missing_ok=True)
        process = subprocess.Popen(['sh', str(ROOT / 'scripts/run-scheduler.sh')],
                                   env=self.env, start_new_session=True)
        try:
            deadline = time.monotonic() + 5
            while not sleeping.exists() and time.monotonic() < deadline:
                if process.poll() is not None:
                    self.fail('Scheduler exited before completing a cycle')
                time.sleep(0.01)
            self.assertTrue(sleeping.exists(), 'Scheduler did not finish a cycle')
        finally:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait()

    def calls(self):
        return (self.root / 'calls').read_text().splitlines()

    def test_restart_does_not_repeat_successful_jobs(self):
        self.run_cycle()
        self.run_cycle()
        self.assertEqual(self.calls(), ['src/cron.js', 'src/recommend.js'])

    def test_next_day_checks_episodes_only(self):
        self.run_cycle()
        self.env['TEST_DAY'] = '2026-11-08'
        self.run_cycle()
        self.assertEqual(self.calls(), ['src/cron.js', 'src/recommend.js', 'src/cron.js'])

    def test_next_iso_week_refreshes_recommendations(self):
        self.run_cycle()
        self.env.update(TEST_DAY='2026-11-09', TEST_WEEK='2026-46')
        self.run_cycle()
        self.assertEqual(self.calls(), ['src/cron.js', 'src/recommend.js'] * 2)

    def test_failed_daily_job_retries_after_restart(self):
        self.env['FAIL_DAILY'] = '1'
        self.run_cycle()
        self.assertFalse((self.state / 'daily').exists())
        self.env['FAIL_DAILY'] = '0'
        self.run_cycle()
        self.assertEqual(self.calls(), ['src/cron.js', 'src/recommend.js', 'src/cron.js'])
        self.assertTrue((self.state / 'daily').exists())


if __name__ == '__main__':
    unittest.main()
