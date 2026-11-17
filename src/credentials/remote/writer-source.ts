/** Fixed-command receiver. Exported as a file; never interpolated into an SSH command. */
export const REMOTE_CREDENTIAL_WRITER_PYTHON = String.raw`#!/usr/bin/python3 -I
"""Ravi credential writer v1. Policy and filesystem access belong to the OS service identity."""
import errno
import fcntl
import hashlib
import json
import os
import re
import secrets
import select
import stat
import sys
import time
import uuid

POLICY_PATH = "/etc/ravi/credential-writer.json"
MAX_FRAME = 20000
MAX_FILE = 1024 * 1024
MAX_STATE = 4 * 1024 * 1024
MAX_REQUESTS = 1024
TIMEOUT = 5.0
MAX_TTL_MS = 600000
PROFILE = "dotenv-single-line-v1"
HEX = re.compile(r"[a-f0-9]{64}\Z")
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
KEY = re.compile(r"[A-Z_][A-Z0-9_]{0,127}\Z")
TOKEN = re.compile(r"[A-Za-z0-9._:/+=-]+\Z")
NOFOLLOW = os.O_NOFOLLOW
CLOEXEC = os.O_CLOEXEC


class Refusal(Exception):
    def __init__(self, code):
        self.code = code


def require(condition, code="INVALID_REQUEST"):
    if not condition:
        raise Refusal(code)


def exact(value, keys):
    require(type(value) is dict and set(value) == set(keys))


def pairs(items):
    result = {}
    for key, value in items:
        require(key not in result)
        result[key] = value
    return result


def decode_json(data):
    return json.loads(data.decode("utf-8"), object_pairs_hook=pairs,
                      parse_constant=lambda unused: require(False))


def canonical_path(path):
    return (isinstance(path, str) and path.startswith("/") and path != "/"
            and "\x00" not in path and "\n" not in path and "\r" not in path
            and all(part not in ("", ".", "..") for part in path.split("/")[1:]))


def check_directory(fd, private=False):
    info = os.fstat(fd)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, os.geteuid())
            and stat.S_IMODE(info.st_mode) & 0o022 == 0, "UNSAFE_PATH")
    if private:
        require(info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700,
                "UNSAFE_PATH")


def open_directory(path, private=False):
    require(path == "/" or canonical_path(path), "UNSAFE_PATH")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW | CLOEXEC)
    try:
        check_directory(fd)
        for component in path.split("/")[1:]:
            if not component:
                continue
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW | CLOEXEC,
                              dir_fd=fd)
            os.close(fd)
            fd = next_fd
            check_directory(fd)
        check_directory(fd, private)
        return fd
    except BaseException:
        os.close(fd)
        raise


def open_parent(path):
    require(canonical_path(path), "UNSAFE_PATH")
    parent, name = path.rsplit("/", 1)
    return open_directory(parent or "/"), name


def check_file(fd, private=True):
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "UNSAFE_PATH")
    if private:
        require(info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o600,
                "UNSAFE_PATH")
    else:
        require(info.st_uid in (0, os.geteuid()) and stat.S_IMODE(info.st_mode) & 0o022 == 0,
                "UNSAFE_PATH")
    return info


def read_file(parent, name, limit, private=True, absent=False):
    try:
        fd = os.open(name, os.O_RDONLY | NOFOLLOW | CLOEXEC | os.O_NONBLOCK, dir_fd=parent)
    except FileNotFoundError:
        if absent:
            return None
        raise
    try:
        before = check_file(fd, private)
        require(before.st_size <= limit, "FILE_TOO_LARGE")
        chunks = []
        size = 0
        while True:
            chunk = os.read(fd, min(65536, limit + 1 - size))
            if not chunk:
                break
            size += len(chunk)
            require(size <= limit, "FILE_TOO_LARGE")
            chunks.append(chunk)
        after = os.fstat(fd)
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns),
                "VERSION_CONFLICT")
        return b"".join(chunks)
    finally:
        os.close(fd)


def digest(data):
    return hashlib.sha256(b"missing" if data is None else b"file:" + data).hexdigest()


def write_all(fd, data):
    offset = 0
    while offset < len(data):
        written = os.write(fd, data[offset:])
        require(written > 0, "IO_ERROR")
        offset += written


def atomic_state(parent, name, value):
    raw = json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")
    require(len(raw) <= MAX_STATE, "REQUEST_LIMIT")
    temporary = ".state-" + secrets.token_hex(24) + ".tmp"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW | CLOEXEC,
                 0o600, dir_fd=parent)
    try:
        check_file(fd)
        write_all(fd, raw)
        os.fsync(fd)
        os.close(fd)
        fd = None
        os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    finally:
        if fd is not None:
            os.close(fd)
        try:
            os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError:
            pass


def load_policy(path):
    parent, name = open_parent(path)
    try:
        raw = read_file(parent, name, 65536, private=False)
    finally:
        os.close(parent)
    try:
        value = decode_json(raw)
        exact(value, ("version", "stateDir", "targets"))
        require(type(value["version"]) is int and value["version"] == 1)
        require(canonical_path(value["stateDir"]))
        require(type(value["targets"]) is list and 0 < len(value["targets"]) <= 128)
        ids, paths, identities = set(), set(), set()
        for target in value["targets"]:
            exact(target, ("id", "envPath", "keys", "profile"))
            require(isinstance(target["id"], str) and ID.fullmatch(target["id"]))
            require(canonical_path(target["envPath"]) and target["envPath"] != path)
            require(not target["envPath"].startswith(value["stateDir"] + "/"))
            require(target["envPath"] != value["stateDir"] and target["profile"] == PROFILE)
            require(type(target["keys"]) is list and 0 < len(target["keys"]) <= 128)
            require(all(isinstance(key, str) and KEY.fullmatch(key) for key in target["keys"]))
            require(len(target["keys"]) == len(set(target["keys"])))
            require(target["id"] not in ids and target["envPath"] not in paths)
            ids.add(target["id"])
            paths.add(target["envPath"])
            env_parent, env_name = open_parent(target["envPath"])
            try:
                try:
                    fd = os.open(env_name, os.O_RDONLY | NOFOLLOW | CLOEXEC | os.O_NONBLOCK,
                                 dir_fd=env_parent)
                except FileNotFoundError:
                    fd = None
                if fd is not None:
                    try:
                        info = check_file(fd)
                        identity = (info.st_dev, info.st_ino)
                        require(identity not in identities)
                        identities.add(identity)
                    finally:
                        os.close(fd)
            finally:
                os.close(env_parent)
        state = open_directory(value["stateDir"], private=True)
        os.close(state)
        return value, hashlib.sha256(raw).hexdigest()
    except (ValueError, TypeError, KeyError, Refusal) as error:
        if isinstance(error, Refusal) and error.code == "UNSAFE_PATH":
            raise
        raise Refusal("INVALID_POLICY") from None


def parse_env(data):
    if data is None:
        return set()
    require(len(data) <= MAX_FILE, "FILE_TOO_LARGE")
    try:
        text = data.decode("utf-8")
    except UnicodeError:
        raise Refusal("UNSUPPORTED_FORMAT") from None
    require("\x00" not in text and "\r" not in text.replace("\r\n", ""), "UNSUPPORTED_FORMAT")
    keys = set()
    # No interpolation, quotes, multiline or ambiguous inline comment syntax in v1.
    for line in text.split("\n"):
        line = line[:-1] if line.endswith("\r") else line
        if not line.strip(" \t") or line.lstrip(" \t").startswith("#"):
            continue
        match = re.fullmatch(r"(?:export )?([A-Z_][A-Z0-9_]{0,127})=([A-Za-z0-9._:/+=-]*)", line)
        require(match is not None, "UNSUPPORTED_FORMAT")
        key = match.group(1)
        require(key not in keys, "UNSUPPORTED_FORMAT")
        keys.add(key)
    return keys


class FrameReader:
    def __init__(self, fd=0):
        self.fd = fd
        self.buffer = b""

    def read(self):
        deadline = time.monotonic() + TIMEOUT
        while b"\n" not in self.buffer:
            require(len(self.buffer) <= MAX_FRAME, "INVALID_REQUEST")
            remaining = deadline - time.monotonic()
            require(remaining > 0, "READ_TIMEOUT")
            ready, unused, unused2 = select.select([self.fd], [], [], remaining)
            require(bool(ready), "READ_TIMEOUT")
            chunk = os.read(self.fd, min(4096, MAX_FRAME + 1 - len(self.buffer)))
            require(bool(chunk), "INVALID_REQUEST")
            self.buffer += chunk
        line, self.buffer = self.buffer.split(b"\n", 1)
        require(len(line) <= MAX_FRAME, "INVALID_REQUEST")
        try:
            result = decode_json(line)
        except (ValueError, TypeError, UnicodeError):
            raise Refusal("INVALID_REQUEST") from None
        require(type(result) is dict and type(result.get("v")) is int and result["v"] == 1)
        return result


def send(value):
    write_all(1, (json.dumps({"v": 1, **value}, separators=(",", ":")) + "\n").encode("ascii"))


def safe_send(value):
    try:
        send(value)
    except Exception:
        # A lost reply is reconciled by STATUS; never print a traceback to stderr.
        return False
    return True


class Writer:
    def __init__(self, policy_path, request, hook=None):
        self.policy_path = policy_path
        self.policy, self.policy_digest = load_policy(policy_path)
        self.hook = hook or (lambda unused: None)
        self.request = request
        require(isinstance(request.get("target"), str), "INVALID_REQUEST")
        self.target = next((target for target in self.policy["targets"]
                            if target["id"] == request["target"]), None)
        require(self.target is not None, "TARGET_NOT_ALLOWED")
        require(request.get("envPath") == self.target["envPath"]
                and request.get("profile") == self.target["profile"], "TARGET_NOT_ALLOWED")
        self.state_fd = open_directory(self.policy["stateDir"], private=True)
        try:
            self.env_fd, self.env_name = open_parent(self.target["envPath"])
        except BaseException:
            os.close(self.state_fd)
            raise
        self.identity = hashlib.sha256(self.target["envPath"].encode("utf-8")).hexdigest()
        self.state_name = self.identity + ".json"
        self.lock_fd = None
        self.state = None

    def close(self):
        if self.lock_fd is not None:
            os.close(self.lock_fd)
            self.lock_fd = None
        os.close(self.env_fd)
        os.close(self.state_fd)

    def lock(self):
        self.lock_fd = os.open(self.identity + ".lock",
                               os.O_RDWR | os.O_CREAT | NOFOLLOW | CLOEXEC, 0o600,
                               dir_fd=self.state_fd)
        check_file(self.lock_fd)
        deadline = time.monotonic() + TIMEOUT
        while True:
            try:
                fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                require(time.monotonic() < deadline, "LOCK_TIMEOUT")
                time.sleep(0.02)

    def snapshot(self):
        current, unused = open_parent(self.target["envPath"])
        try:
            a, b = os.fstat(current), os.fstat(self.env_fd)
            require((a.st_dev, a.st_ino) == (b.st_dev, b.st_ino), "UNSAFE_PATH")
        finally:
            os.close(current)
        return read_file(self.env_fd, self.env_name, MAX_FILE, absent=True)

    def save(self):
        atomic_state(self.state_fd, self.state_name, self.state)

    def load(self, data):
        raw = read_file(self.state_fd, self.state_name, MAX_STATE, absent=True)
        if raw is None:
            self.state = {"v": 1, "target": self.target["id"], "path": self.target["envPath"],
                          "version": secrets.token_hex(32), "digest": digest(data), "requests": {}}
            self.save()
            return
        try:
            value = decode_json(raw)
            exact(value, ("v", "target", "path", "version", "digest", "requests"))
            require(value["v"] == 1 and value["target"] == self.target["id"]
                    and value["path"] == self.target["envPath"])
            require(isinstance(value["version"], str) and HEX.fullmatch(value["version"]))
            require(isinstance(value["digest"], str) and HEX.fullmatch(value["digest"]))
            require(type(value["requests"]) is dict and len(value["requests"]) <= MAX_REQUESTS)
            for request_id, record in value["requests"].items():
                require(isinstance(request_id, str) and ID.fullmatch(request_id))
                require(type(record) is dict and record.get("phase") in
                        ("reserved", "prepared", "stored", "not_applied", "uncertain", "fenced"))
                if record["phase"] == "fenced":
                    exact(record, ("phase", "target", "envPath", "profile", "requestId"))
                    require(record["target"] == value["target"] and record["envPath"] == value["path"]
                            and record["profile"] == PROFILE and record["requestId"] == request_id)
                    continue
                binding = record.get("binding")
                validate_request(binding, "prepare")
                require(binding["requestId"] == request_id and binding["target"] == value["target"]
                        and binding["envPath"] == value["path"])
                if record["phase"] != "reserved":
                    for key in ("before", "after", "receipt", "version"):
                        require(isinstance(record.get(key), str) and HEX.fullmatch(record[key]))
                    require(isinstance(record.get("temporary"), str) and
                            re.fullmatch(r"\.ravi-[a-f0-9]{48}\.tmp", record["temporary"]))
            self.state = value
        except (Refusal, ValueError, KeyError, TypeError):
            raise Refusal("UNCERTAIN") from None

    def cleanup(self, name):
        try:
            fd = os.open(name, os.O_RDONLY | NOFOLLOW | CLOEXEC | os.O_NONBLOCK, dir_fd=self.env_fd)
        except FileNotFoundError:
            return
        try:
            check_file(fd)
        finally:
            os.close(fd)
        os.unlink(name, dir_fd=self.env_fd)
        os.fsync(self.env_fd)

    def reconcile(self, data):
        current = digest(data)
        unresolved = [record for record in self.state["requests"].values()
                      if record["phase"] in ("prepared", "uncertain")]
        require(len(unresolved) <= 1, "UNCERTAIN")
        changed = False
        for record in unresolved:
            if current == record["after"]:
                # A crash after rename may precede directory durability. A matching
                # snapshot is not a durable receipt until the rename is synced.
                try:
                    self.hook("before_recovery_fsync")
                    os.fsync(self.env_fd)
                    self.hook("after_recovery_fsync")
                except OSError:
                    raise Refusal("UNCERTAIN") from None
                record["phase"] = "stored"
                self.state["version"] = record["version"]
                self.state["digest"] = current
                self.cleanup(record["temporary"])
            elif current == record["before"]:
                record["phase"] = "not_applied"
                self.cleanup(record["temporary"])
            else:
                record["phase"] = "uncertain"
            changed = True
        blocked = any(record["phase"] == "uncertain" for record in self.state["requests"].values())
        if not blocked and self.state["digest"] != current:
            self.state["digest"] = current
            self.state["version"] = secrets.token_hex(32)
            changed = True
        if changed:
            self.save()
        return blocked

    def check_key(self):
        require(self.request["key"] in self.target["keys"], "KEY_NOT_ALLOWED")

    def check_expiry(self):
        remaining = self.request["expiresAt"] - int(time.time() * 1000)
        require(0 < remaining <= MAX_TTL_MS, "REQUEST_EXPIRED")

    def result(self, record):
        return {"status": "stored", "receipt": record["receipt"], "version": record["version"]}

    def run(self, reader):
        self.lock()
        data = self.snapshot()
        self.load(data)
        blocked = self.reconcile(data)
        request = self.request
        op = request["op"]
        if op == "status":
            record = self.state["requests"].get(request["requestId"])
            if record and record["phase"] == "stored":
                return self.result(record)
            if blocked:
                return {"status": "uncertain"}
            # A negative status is final: fence late PREPAREs before acknowledging it.
            require(record is not None or len(self.state["requests"]) < MAX_REQUESTS, "REQUEST_LIMIT")
            self.state["requests"][request["requestId"]] = {
                "phase": "fenced", "target": request["target"], "envPath": request["envPath"],
                "profile": request["profile"], "requestId": request["requestId"]}
            self.save()
            return {"status": "not_found"}
        require(not blocked, "UNCERTAIN")
        self.check_key()
        if op == "prepare":
            record = self.state["requests"].get(request["requestId"])
            if record:
                require(record["phase"] != "fenced", "REQUEST_CONFLICT")
                require(record["binding"] == request, "REQUEST_CONFLICT")
                if record["phase"] == "stored":
                    return self.result(record)
                require(record["phase"] == "reserved", "REQUEST_CONFLICT")
        require(request["key"] not in parse_env(data), "KEY_EXISTS")
        if op == "preflight":
            return {"status": "ready", "version": self.state["version"]}
        self.check_expiry()
        require(request["expectedVersion"] == self.state["version"], "VERSION_CONFLICT")
        require(request["requestId"] in self.state["requests"] or
                len(self.state["requests"]) < MAX_REQUESTS, "REQUEST_LIMIT")
        self.state["requests"][request["requestId"]] = {"phase": "reserved", "binding": request}
        self.save()
        nonce = secrets.token_hex(32)
        send({"status": "ready", "nonce": nonce})
        commit = reader.read()
        validate_commit(commit)
        require(secrets.compare_digest(commit["nonce"], nonce), "INVALID_NONCE")
        self.check_expiry()
        policy, policy_digest = load_policy(self.policy_path)
        require(policy_digest == self.policy_digest and policy == self.policy, "VERSION_CONFLICT")
        latest = self.snapshot()
        require(digest(latest) == digest(data), "VERSION_CONFLICT")
        secret = commit["secret"]
        require(isinstance(secret, str) and 0 < len(secret) <= 8192 and TOKEN.fullmatch(secret),
                "SECRET_INVALID")
        # Only append the absent key. Every existing byte is retained exactly.
        existing = latest or b""
        ending = b"\r\n" if b"\r\n" in existing else b"\n"
        separator = ending if existing and not existing.endswith(b"\n") else b""
        candidate = existing + separator + request["key"].encode("ascii") + b"=" + secret.encode("ascii") + ending
        require(len(candidate) <= MAX_FILE, "FILE_TOO_LARGE")
        temporary = ".ravi-" + secrets.token_hex(24) + ".tmp"
        record = {"phase": "prepared", "binding": request, "before": digest(latest),
                  "after": digest(candidate), "receipt": secrets.token_hex(32),
                  "version": secrets.token_hex(32), "temporary": temporary}
        self.state["requests"][request["requestId"]] = record
        self.save()
        attempted_rename = False
        fd = None
        try:
            self.hook("after_prepare")
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW | CLOEXEC,
                         0o600, dir_fd=self.env_fd)
            check_file(fd)
            write_all(fd, candidate)
            os.fsync(fd)
            self.hook("after_temp_fsync")
            os.close(fd)
            fd = None
            require(digest(self.snapshot()) == record["before"], "VERSION_CONFLICT")
            self.hook("before_rename")
            attempted_rename = True
            os.replace(temporary, self.env_name, src_dir_fd=self.env_fd, dst_dir_fd=self.env_fd)
            self.hook("after_rename")
            os.fsync(self.env_fd)
            self.hook("after_directory_fsync")
            record["phase"] = "stored"
            self.state["digest"] = record["after"]
            self.state["version"] = record["version"]
            self.save()
            self.hook("after_finalize")
            return self.result(record)
        except BaseException:
            if attempted_rename:
                raise Refusal("UNCERTAIN") from None
            raise
        finally:
            if fd is not None:
                os.close(fd)


def validate_request(request, expected=None):
    require(type(request) is dict and type(request.get("v")) is int and request["v"] == 1)
    op = request.get("op")
    require(op in ("preflight", "prepare", "status") and (expected is None or op == expected))
    fields = ["v", "op", "target", "envPath", "profile"]
    fields += ["requestId"] if op == "status" else ["key"]
    if op == "prepare":
        fields += ["requestId", "expectedVersion", "expiresAt", "destinationVersion"]
    exact(request, fields)
    require(isinstance(request["target"], str) and ID.fullmatch(request["target"]))
    require(canonical_path(request["envPath"]) and request["profile"] == PROFILE)
    if op != "status":
        require(isinstance(request["key"], str) and KEY.fullmatch(request["key"]))
    if op != "preflight":
        require(isinstance(request["requestId"], str) and ID.fullmatch(request["requestId"]))
    if op == "prepare":
        require(isinstance(request["expectedVersion"], str) and HEX.fullmatch(request["expectedVersion"]))
        require(type(request["expiresAt"]) is int and request["expiresAt"] > 0)
        try:
            require(isinstance(request["destinationVersion"], str) and
                    str(uuid.UUID(request["destinationVersion"])) == request["destinationVersion"])
        except (ValueError, AttributeError, TypeError):
            raise Refusal("INVALID_REQUEST") from None


def validate_commit(value):
    exact(value, ("v", "op", "nonce", "secret"))
    require(type(value["v"]) is int and value["v"] == 1 and value["op"] == "commit")
    require(isinstance(value["nonce"], str) and HEX.fullmatch(value["nonce"]), "INVALID_NONCE")


def main(policy_path=POLICY_PATH, hook=None):
    writer = None
    try:
        reader = FrameReader()
        request = reader.read()
        validate_request(request)
        writer = Writer(policy_path, request, hook)
        result = writer.run(reader)
        return 0 if safe_send(result) else 1
    except Refusal as error:
        safe_send({"status": "error", "code": error.code})
        return 1
    except OSError as error:
        # OS errors may contain paths/data. Expose only a fixed classification.
        code = "UNSAFE_PATH" if error.errno in (errno.ELOOP, errno.ENOTDIR) else "IO_ERROR"
        safe_send({"status": "error", "code": code})
        return 1
    except Exception:
        safe_send({"status": "error", "code": "IO_ERROR"})
        return 1
    finally:
        if writer is not None:
            try:
                writer.close()
            except OSError:
                pass


if __name__ == "__main__":
    if len(sys.argv) != 1:
        safe_send({"status": "error", "code": "INVALID_REQUEST"})
        sys.exit(1)
    sys.exit(main())
`;
