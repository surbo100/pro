import tempfile
import unittest
from pathlib import Path
from hash_probe import probe

class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.paths = {name: Path(self.tmp.name) / (name + '.jpg') for name in ['original', 'renamed', 'new']}
        for name, path in self.paths.items():
            path.write_bytes(b'original bytes' if name != 'new' else b'new bytes')

    def test_expected_three_lookups(self):
        calls = []
        def lookup(value):
            calls.append(value)
            return 'media-1' if len(calls) <= 2 else None
        result = probe(self.paths, lookup)
        self.assertTrue(result['expectations_met'])
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[0], calls[1])

    def test_network_failure_is_not_missing(self):
        def lookup(_):
            raise RuntimeError('sensitive server error')
        result = probe(self.paths, lookup)
        self.assertFalse(result['expectations_met'])
        self.assertEqual(result['results']['new']['status'], 'query_error')
        self.assertNotIn('sensitive', str(result))

    def test_wrong_sample_prevents_lookup(self):
        self.paths['renamed'].write_bytes(b'edited')
        with self.assertRaises(ValueError):
            probe(self.paths, lambda _: self.fail('No request expected'))

    def test_different_remote_ids_do_not_pass(self):
        keys = iter(['one', 'two', None])
        self.assertFalse(probe(self.paths, lambda _: next(keys))['expectations_met'])

if __name__ == '__main__':
    unittest.main()
