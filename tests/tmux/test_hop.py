import importlib.util
from pathlib import Path
import re
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
HOP = ROOT / 'home/.config/tmux/hop/hop.py'
sys.path.insert(0, str(HOP.parent))
hop = None
if HOP.exists():
    spec = importlib.util.spec_from_file_location('hop', HOP)
    hop = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hop)


class HopTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(hop, 'Hop adapter has not been implemented')

    def test_word_targets_rank_nearby_rows_and_columns_first(self):
        self.assertEqual(hop.targets(['alpha beta', 'gamma'], 'words', '', (1, 8)),
                         [(1, 0), (0, 6), (0, 0)])

    def test_current_cell_is_excluded(self):
        self.assertEqual(hop.targets(['alpha beta'], 'words', '', (0, 0)), [(0, 6)])

    def test_regex_is_case_insensitive_and_uses_match_start(self):
        self.assertEqual(hop.targets(['ABC abacus', 'Abc'], 'pattern', 'ab[c]', (1, 4)),
                         [(1, 0), (0, 0)])

    def test_empty_and_zero_length_patterns_have_no_targets(self):
        self.assertEqual(hop.targets(['alpha'], 'pattern', '', (0, 7)), [])
        self.assertEqual(hop.targets(['alpha'], 'pattern', '^', (0, 7)), [])

    def test_invalid_pattern_reports_regex_error(self):
        with self.assertRaises(re.error):
            hop.targets(['alpha'], 'pattern', '[', (0, 7))

    def test_wide_and_combining_characters_use_terminal_cells(self):
        self.assertEqual(hop.targets(['界 alpha e\u0301clair'], 'words', '', (0, 18)),
                         [(0, 9), (0, 3), (0, 0)])
        self.assertEqual(hop.targets(['界 alpha'], 'pattern', 'alpha', (0, 12)), [(0, 3)])

    def test_shortest_labels_go_to_nearest_targets(self):
        points = [(0, i) for i in range(28)]
        labels = hop.labels_for(points)
        self.assertEqual(labels['a'], (0, 0))
        self.assertEqual(labels['f'], (0, 24))
        self.assertEqual(labels['ja'], (0, 25))
        self.assertEqual(labels['js'], (0, 26))
        self.assertEqual(labels['jd'], (0, 27))

    def test_labels_remain_unique_and_prefix_free_at_large_counts(self):
        for count in (0, 1, 26, 27, 676, 800):
            with self.subTest(count=count):
                points = [(i, 0) for i in range(count)]
                labels = hop.labels_for(points)
                self.assertEqual(set(labels.values()), set(points))
                for a in labels:
                    self.assertFalse(any(b != a and b.startswith(a) for b in labels))

    def test_renderer_clips_last_column_previews_and_preserves_adjacent_hints(self):
        output = hop.render(['abcde'], {'as': (0, 3), 'sa': (0, 4)}, 5, 1)
        self.assertIn('\x1b[1;4H', output)
        self.assertIn('\x1b[1;5H', output)
        self.assertNotIn('\x1b[1;6H', output)
        self.assertNotIn(hop.SECOND + 's', output)
        self.assertNotIn(hop.SECOND + 'a', output)

    def test_renderer_neutralizes_capture_control_sequences(self):
        output = hop.render(['abc\x1b]52;clipboard\x07'], {}, 30, 1)
        self.assertNotIn('\x1b]52', output)
        self.assertNotIn('\x07', output)


if __name__ == '__main__':
    unittest.main()