#!/usr/bin/env python3
"""Regression net for the idle predicate in codeintel-instance-prune.py.

The policy these tests pin (see the script header and TODO.md):
  * git root  : idle ONLY when commit age AND last-dial age are both >= window
  * non-git   : idle when last-dial alone is >= window (no commit signal)
  * never dialed (ActiveEnterTimestamp empty => epoch 0) reads as cold

The script under test is imported via importlib (its filename is a script, not
a module name). `classify` takes an explicit `now` and calls `last_dialed_epoch`,
`is_git_root`, and `last_commit_epoch`, which these tests drive by patching the
module attributes, so no real git/systemctl/date is invoked.
"""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("codeintel-instance-prune.py")
spec = importlib.util.spec_from_file_location("prune", SCRIPT)
prune = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prune)

NOW = 1780272000  # 2026-06-01T00:00:00Z
DAY = 86400
WINDOW = prune.IDLE_SECS


class ClassifyTest(unittest.TestCase):
    def setUp(self) -> None:
        self._saved = (
            prune.last_dialed_epoch, prune.is_git_root, prune.last_commit_epoch,
        )

    def tearDown(self) -> None:
        prune.last_dialed_epoch, prune.is_git_root, prune.last_commit_epoch = self._saved

    def stub(self, *, dialed_epoch: int, is_git: bool, commit_epoch: int = 0) -> None:
        prune.last_dialed_epoch = lambda unit: dialed_epoch
        prune.is_git_root = lambda root: is_git
        prune.last_commit_epoch = lambda root: commit_epoch

    def test_git_root_both_signals_stale_is_idle(self) -> None:
        self.stub(dialed_epoch=NOW - 20 * DAY, is_git=True, commit_epoch=NOW - 20 * DAY)
        self.assertEqual(prune.classify("/proj", "cclsp", "8811", now=NOW), "commit=20d|dialed=20d")

    def test_git_root_recent_commit_spares_stale_dial(self) -> None:
        self.stub(dialed_epoch=NOW - 20 * DAY, is_git=True, commit_epoch=NOW - 2 * DAY)
        self.assertIsNone(prune.classify("/proj", "cclsp", "8811", now=NOW))

    def test_git_root_recent_dial_spares_stale_commit(self) -> None:
        self.stub(dialed_epoch=NOW - 2 * DAY, is_git=True, commit_epoch=NOW - 20 * DAY)
        self.assertIsNone(prune.classify("/proj", "cclsp", "8811", now=NOW))

    def test_non_git_stale_dial_alone_is_idle(self) -> None:
        self.stub(dialed_epoch=NOW - 20 * DAY, is_git=False, commit_epoch=NOW - 1 * DAY)
        self.assertEqual(prune.classify("/proj", "cclsp", "8811", now=NOW), "nongit|dialed=20d")

    def test_non_git_recent_dial_spares(self) -> None:
        self.stub(dialed_epoch=NOW - 2 * DAY, is_git=False)
        self.assertIsNone(prune.classify("/proj", "cclsp", "8811", now=NOW))

    def test_never_dialed_reads_as_cold(self) -> None:
        self.stub(dialed_epoch=0, is_git=False)
        self.assertEqual(prune.classify("/proj", "cclsp", "8811", now=NOW), "nongit|dialed=14d")

    def test_never_committed_git_root_reads_as_cold(self) -> None:
        self.stub(dialed_epoch=NOW - 20 * DAY, is_git=True, commit_epoch=0)
        self.assertEqual(prune.classify("/proj", "cclsp", "8811", now=NOW), "commit=14d|dialed=20d")


class ReadConfTest(unittest.TestCase):
    def test_extracts_project_and_port_for_server_keys(self) -> None:
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            conf = Path(tmp) / "8801.conf"
            conf.write_text("# cclsp instance\nCCLSP_PROJECT=/home/x\nCCLSP_PROXY_PORT=8801\n")
            self.assertEqual(
                prune.read_conf(conf, "CCLSP_PROJECT", "CCLSP_PROXY_PORT"),
                ("/home/x", "8801"),
            )

    def test_missing_keys_yield_empty_strings(self) -> None:
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            conf = Path(tmp) / "x.conf"
            conf.write_text("SERENA_PROJECT=/p\n")
            self.assertEqual(
                prune.read_conf(conf, "CCLSP_PROJECT", "CCLSP_PROXY_PORT"),
                ("", ""),
            )


if __name__ == "__main__":
    unittest.main()
