"""A stand-in native-messaging host for the protection end-to-end test.

Firefox launches this and talks to it with 4-byte-length-prefixed JSON. For every request
it replies with the JSON object currently in the status file named in argv[1], so the test
can flip the reported protection status between messages. Not used in production - the real
host is studymode_protection.nativehost.
"""

import json
import struct
import sys


def main(status_path):
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    while True:
        raw_len = stdin.read(4)
        if len(raw_len) < 4:
            return
        (length,) = struct.unpack("<I", raw_len)
        stdin.read(length)  # ignore request contents; always reply with current status
        try:
            with open(status_path, "r", encoding="utf-8") as fh:
                status = json.load(fh)
        except Exception as exc:  # noqa: BLE001
            status = {"type": "error", "message": str(exc)}
        data = json.dumps(status).encode("utf-8")
        stdout.write(struct.pack("<I", len(data)) + data)
        stdout.flush()


if __name__ == "__main__":
    main(sys.argv[1])
