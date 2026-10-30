"""Read-only, three-file Google Photos hash lookup experiment."""
import argparse
import hashlib
import json
import logging
import os
from pathlib import Path


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha1').hexdigest()


def probe(paths, lookup):
    hashes = {name: digest(path) for name, path in paths.items()}
    if hashes['original'] != hashes['renamed']:
        raise ValueError('Renamed copy must contain exactly the original bytes.')
    if hashes['new'] == hashes['original']:
        raise ValueError('New photo must differ from the original.')
    results = {}
    for name, value in hashes.items():
        try:
            key = lookup(value)
            if key is not None and (not isinstance(key, str) or not key):
                raise ValueError('Unexpected response')
            results[name] = {'sha1': value, 'status': 'found' if key else 'not_found', 'media_key': key}
        except Exception:
            # Do not serialize authentication errors or raw response bodies.
            results[name] = {'sha1': value, 'status': 'query_error', 'media_key': None}
    passed = (results['original']['status'] == 'found'
              and results['renamed']['status'] == 'found'
              and results['original']['media_key'] == results['renamed']['media_key']
              and results['new']['status'] == 'not_found')
    return {'expectations_met': passed, 'results': results,
            'meaning': 'Registration lookup only; not a cloud original integrity check.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['original', 'renamed', 'new']:
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--live', action='store_true', help='Perform actual authenticated lookups; default is local validation only.')
    args = parser.parse_args()
    paths = {name: getattr(args, name) for name in ['original', 'renamed', 'new']}
    for path in paths.values():
        if not path.is_file() or not path.stat().st_size:
            parser.error('All three inputs must be nonempty local files.')
    # Validate the sample before any authentication or network operation.
    original, renamed, fresh = [digest(paths[n]) for n in ['original', 'renamed', 'new']]
    if original != renamed or original == fresh:
        parser.error('Original/renamed must be byte-identical; new must be different.')
    if not args.live:
        print(json.dumps({'mode': 'local_only', 'sample_valid': True, 'cloud_lookups': 0}))
        return 0
    if not os.environ.get('GP_AUTH_DATA'):
        print(json.dumps({'mode': 'blocked', 'reason': 'GP_AUTH_DATA is not configured locally.'}))
        return 2
    logging.disable(logging.CRITICAL)
    try:
        from gpmc import Client
        client = Client(log_level='CRITICAL', timeout=30)
    except Exception:
        print(json.dumps({'mode': 'blocked', 'reason': 'Client initialization failed. Check local gpmc installation/authentication; no credentials logged.'}))
        return 2
    report = probe(paths, client.get_media_key_by_hash)
    report['mode'] = 'live'
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['expectations_met'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
