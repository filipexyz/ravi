#ifndef _WIN32

#include "platform.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <linux/fs.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <sstream>

namespace ravi::specs_safe_fs {
namespace {

constexpr std::uint64_t kResolvePolicy = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
                                         RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV;

[[noreturn]] void fail_errno(const std::string& code, const std::string& path, const std::string& action) {
  throw SafeFsError(code, path, action + ": " + std::strerror(errno));
}

int openat2_raw(int parent, const std::string& name, int flags, mode_t mode = 0) {
  struct open_how how {};
  how.flags = static_cast<std::uint64_t>(flags);
  how.mode = static_cast<std::uint64_t>(mode);
  how.resolve = kResolvePolicy;
  return static_cast<int>(syscall(SYS_openat2, parent, name.c_str(), &how, sizeof(how)));
}

std::string identity_from_stat(const struct stat& stat_value) {
  return std::to_string(static_cast<std::uint64_t>(stat_value.st_dev)) + ":" +
         std::to_string(static_cast<std::uint64_t>(stat_value.st_ino));
}

EntryInfo info_from_stat(const struct stat& stat_value) {
  EntryInfo info;
  info.directory = S_ISDIR(stat_value.st_mode);
  info.regular_file = S_ISREG(stat_value.st_mode);
  info.mtime_ms = static_cast<std::uint64_t>(stat_value.st_mtim.tv_sec) * 1000ULL +
                  static_cast<std::uint64_t>(stat_value.st_mtim.tv_nsec / 1000000ULL);
  info.size = static_cast<std::uint64_t>(stat_value.st_size);
  info.identity = identity_from_stat(stat_value);
  if (info.regular_file && stat_value.st_nlink != 1) {
    throw SafeFsError("UNSAFE_HARD_LINK", info.identity, "Hard-linked files are not allowed in the specs tree");
  }
  if (!info.directory && !info.regular_file) {
    throw SafeFsError("UNSAFE_ENTRY", info.identity, "Non-regular entries are not allowed in the specs tree");
  }
  return info;
}

bool same_identity(const EntryInfo& left, const EntryInfo& right) { return left.identity == right.identity; }

std::vector<std::string> absolute_segments(const std::string& path) {
  if (path.empty() || path.front() != '/') {
    throw SafeFsError("INVALID_DATABASE_PATH", path, "Database path must be absolute");
  }
  std::vector<std::string> segments;
  std::size_t start = 1;
  while (start <= path.size()) {
    const std::size_t end = path.find('/', start);
    const std::string segment = path.substr(start, end == std::string::npos ? end : end - start);
    if (!segment.empty()) {
      if (segment == "." || segment == ".." || segment.find('\0') != std::string::npos) {
        throw SafeFsError("INVALID_DATABASE_PATH", path, "Database path contains an unsafe segment");
      }
      segments.push_back(segment);
    }
    if (end == std::string::npos) break;
    start = end + 1;
  }
  if (segments.empty()) throw SafeFsError("INVALID_DATABASE_PATH", path, "Database path has no file name");
  return segments;
}

std::string database_binding(const Handle& parent, const std::string& name, const std::optional<Handle>& file) {
  return "parent:" + entry_info(parent).identity + ";name:" + name + ";file:" +
         (file ? entry_info(*file).identity : "missing");
}

bool raw_entry_matches(const Handle& parent, const std::string& name, const Handle& expected) {
  struct stat current {};
  struct stat pinned {};
  if (fstat(expected.get(), &pinned) != 0) fail_errno("SAFE_STAT_FAILED", name, "Cannot inspect pinned entry");
  if (fstatat(parent.get(), name.c_str(), &current, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT) return false;
    fail_errno("SAFE_STAT_FAILED", name, "Cannot inspect named entry during rollback");
  }
  return current.st_dev == pinned.st_dev && current.st_ino == pinned.st_ino;
}

}  // namespace

Handle::~Handle() { reset(); }

void Handle::reset(RawHandle value) {
  if (valid()) close(value_);
  value_ = value;
}

Handle open_workspace(const std::string& absolute_path) {
  const int descriptor = open(absolute_path.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (descriptor < 0) fail_errno("WORKSPACE_OPEN_FAILED", absolute_path, "Cannot open workspace");
  Handle handle(descriptor);
  (void)entry_info(handle);
  return handle;
}

std::optional<OpenedEntry> open_entry_at(const Handle& parent, const std::string& name) {
  const int descriptor = openat2_raw(parent.get(), name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (descriptor < 0) {
    if (errno == ENOENT) return std::nullopt;
    if (errno == ENOSYS || errno == E2BIG) {
      fail_errno("UNSUPPORTED_FILESYSTEM_PRIMITIVE", name, "openat2 is required for safe specs access");
    }
    if (errno == ELOOP || errno == EXDEV) {
      fail_errno("UNSAFE_LINK", name, "Link or mount traversal is not allowed in the specs tree");
    }
    fail_errno("SAFE_OPEN_FAILED", name, "Cannot open specs entry safely");
  }
  Handle handle(descriptor);
  EntryInfo info = entry_info(handle);
  return OpenedEntry{std::move(handle), std::move(info)};
}

std::optional<OpenedEntry> open_writable_file_at(const Handle& parent, const std::string& name) {
  const int descriptor = openat2_raw(parent.get(), name, O_RDWR | O_CLOEXEC | O_NOFOLLOW);
  if (descriptor < 0) {
    if (errno == ENOENT) return std::nullopt;
    if (errno == ELOOP || errno == EXDEV) fail_errno("UNSAFE_LINK", name, "Link traversal is not allowed");
    fail_errno("SAFE_OPEN_FAILED", name, "Cannot open specs file safely for writing");
  }
  Handle handle(descriptor);
  EntryInfo info = entry_info(handle);
  if (!info.regular_file) throw SafeFsError("UNSAFE_ENTRY", name, "Writable specs entry is not a regular file");
  return OpenedEntry{std::move(handle), std::move(info)};
}

bool pinned_entry_still_named(const Handle& parent, const std::string& name, const Handle& expected) {
  auto current = open_entry_at(parent, name);
  return current && current->info.identity == entry_info(expected).identity;
}

Handle create_directory_at(const Handle& parent, const std::string& name) {
  if (mkdirat(parent.get(), name.c_str(), 0700) != 0) {
    fail_errno("SAFE_CREATE_FAILED", name, "Cannot create specs directory");
  }
  try {
    if (const char* forced = std::getenv("RAVI_TEST_ONLY_FORCE_OPENAT2_ENOSYS_AFTER_MKDIR");
        forced != nullptr && (std::string(forced) == "1" || std::string(forced) == name)) {
      errno = ENOSYS;
      fail_errno("UNSUPPORTED_FILESYSTEM_PRIMITIVE", name, "openat2 is required for safe specs access");
    }
    auto opened = open_entry_at(parent, name);
    if (!opened || !opened->info.directory) {
      throw SafeFsError("SAFE_CREATE_FAILED", name, "Created specs directory could not be pinned");
    }
    return std::move(opened->handle);
  } catch (...) {
    const std::exception_ptr original_error = std::current_exception();
    const int descriptor = openat(parent.get(), name.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (descriptor < 0) fail_errno("ROLLBACK_FAILED", name, "Cannot pin newly created directory for rollback");
    Handle created(descriptor);
    if (!remove_empty_directory_at(parent, name, created)) {
      throw SafeFsError("ROLLBACK_FAILED", name, "Newly created directory was not removed after primitive failure");
    }
    std::rethrow_exception(original_error);
  }
}

Handle create_movable_directory_at(const Handle& parent, const std::string& name) {
  return create_directory_at(parent, name);
}

Handle create_file_at(const Handle& parent, const std::string& name) {
  const int descriptor = openat2_raw(parent.get(), name, O_RDWR | O_CLOEXEC | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (descriptor < 0) fail_errno("SAFE_CREATE_FAILED", name, "Cannot create specs file");
  Handle handle(descriptor);
  const EntryInfo info = entry_info(handle);
  if (!info.regular_file) throw SafeFsError("UNSAFE_ENTRY", name, "Created specs entry is not a regular file");
  return handle;
}

std::vector<std::string> list_directory(const Handle& directory) {
  const int duplicate = dup(directory.get());
  if (duplicate < 0) fail_errno("SAFE_ENUMERATION_FAILED", "", "Cannot duplicate specs directory handle");
  DIR* stream = fdopendir(duplicate);
  if (stream == nullptr) {
    close(duplicate);
    fail_errno("SAFE_ENUMERATION_FAILED", "", "Cannot enumerate specs directory");
  }
  std::vector<std::string> names;
  errno = 0;
  while (dirent* entry = readdir(stream)) {
    const std::string name(entry->d_name);
    if (name != "." && name != "..") names.push_back(name);
  }
  const int enumeration_errno = errno;
  closedir(stream);
  if (enumeration_errno != 0) {
    errno = enumeration_errno;
    fail_errno("SAFE_ENUMERATION_FAILED", "", "Cannot enumerate complete specs directory");
  }
  return names;
}

EntryInfo entry_info(const Handle& handle) {
  struct stat stat_value {};
  if (fstat(handle.get(), &stat_value) != 0) fail_errno("SAFE_STAT_FAILED", "", "Cannot inspect pinned entry");
  return info_from_stat(stat_value);
}

std::string read_all(const Handle& file) {
  const EntryInfo info = entry_info(file);
  if (!info.regular_file) throw SafeFsError("UNSAFE_ENTRY", info.identity, "Only regular specs files can be read");
  if (lseek(file.get(), 0, SEEK_SET) < 0) fail_errno("SAFE_READ_FAILED", info.identity, "Cannot seek specs file");
  std::string result;
  result.resize(static_cast<std::size_t>(info.size));
  std::size_t offset = 0;
  while (offset < result.size()) {
    const ssize_t count = read(file.get(), result.data() + offset, result.size() - offset);
    if (count < 0) fail_errno("SAFE_READ_FAILED", info.identity, "Cannot read specs file");
    if (count == 0) break;
    offset += static_cast<std::size_t>(count);
  }
  result.resize(offset);
  return result;
}

void replace_contents(const Handle& file, const std::string& content) {
  if (ftruncate(file.get(), 0) != 0 || lseek(file.get(), 0, SEEK_SET) < 0) {
    fail_errno("SAFE_WRITE_FAILED", "", "Cannot truncate pinned specs file");
  }
  write_all(file, content);
}

void write_all(const Handle& file, const std::string& content) {
  std::size_t offset = 0;
  while (offset < content.size()) {
    const ssize_t count = write(file.get(), content.data() + offset, content.size() - offset);
    if (count < 0) fail_errno("SAFE_WRITE_FAILED", "", "Cannot write pinned specs file");
    offset += static_cast<std::size_t>(count);
  }
}

void flush_handle(const Handle& handle) {
  if (fsync(handle.get()) != 0) fail_errno("SAFE_FLUSH_FAILED", "", "Cannot flush pinned specs entry");
}

void promote_directory_no_replace(
    const Handle& parent,
    const std::string& staging_name,
    const Handle& staging,
    const std::string& target_name,
    const std::string& recovery_name,
    const std::function<void()>& immediately_before_rename) {
  const EntryInfo expected = entry_info(staging);
  if (!pinned_entry_still_named(parent, staging_name, staging)) {
    throw SafeFsError("SAFE_STAGE_CHANGED", staging_name, "Pinned staging directory is no longer at its private name");
  }
  if (immediately_before_rename) immediately_before_rename();
  if (syscall(SYS_renameat2, parent.get(), staging_name.c_str(), parent.get(), target_name.c_str(), RENAME_NOREPLACE) !=
      0) {
    if (errno == ENOSYS || errno == EINVAL || errno == EOPNOTSUPP) {
      fail_errno("UNSUPPORTED_FILESYSTEM_PRIMITIVE", target_name, "renameat2 RENAME_NOREPLACE is required");
    }
    fail_errno("SAFE_PROMOTION_FAILED", target_name, "Cannot promote specs directory without replacement");
  }
  auto promoted = open_entry_at(parent, target_name);
  if (!promoted || !promoted->info.directory || !same_identity(expected, promoted->info)) {
    if (promoted) {
      if (syscall(
              SYS_renameat2,
              parent.get(),
              target_name.c_str(),
              parent.get(),
              recovery_name.c_str(),
              RENAME_NOREPLACE) != 0) {
        fail_errno(
            "PROMOTION_ROLLBACK_FAILED", target_name, "Cannot quarantine a concurrently substituted promotion target");
      }
      auto quarantined = open_entry_at(parent, recovery_name);
      if (!quarantined || !same_identity(promoted->info, quarantined->info) || open_entry_at(parent, target_name)) {
        throw SafeFsError(
            "PROMOTION_ROLLBACK_FAILED", target_name, "Promotion rollback could not be verified by identity");
      }
    }
    throw SafeFsError("PROMOTION_IDENTITY_CHANGED", target_name, "Promoted specs directory identity changed concurrently");
  }
}

bool remove_private_tree(const Handle& parent, const std::string& name, const Handle& expected_directory) {
  const EntryInfo expected = entry_info(expected_directory);
  auto current = open_entry_at(parent, name);
  if (!current) return false;
  if (!current->info.directory || !same_identity(expected, current->info)) return false;
  for (const std::string& child_name : list_directory(current->handle)) {
    auto child = open_entry_at(current->handle, child_name);
    if (!child || !child->info.regular_file || unlinkat(current->handle.get(), child_name.c_str(), 0) != 0) {
      throw SafeFsError("STAGING_CLEANUP_FAILED", child_name, "Cannot remove a pinned private staging entry");
    }
  }
  if (unlinkat(parent.get(), name.c_str(), AT_REMOVEDIR) != 0) {
    fail_errno("STAGING_CLEANUP_FAILED", name, "Cannot remove pinned private staging directory");
  }
  return true;
}

bool remove_empty_directory_at(const Handle& parent, const std::string& name, const Handle& expected_directory) {
  if (!raw_entry_matches(parent, name, expected_directory)) return false;
  if (unlinkat(parent.get(), name.c_str(), AT_REMOVEDIR) == 0) return true;
  if (errno == ENOTEMPTY || errno == EEXIST) return false;
  fail_errno("ROLLBACK_FAILED", name, "Cannot remove newly created empty directory");
}

DatabaseState open_database_state(const std::string& absolute_path) {
  const std::vector<std::string> segments = absolute_segments(absolute_path);
  const int root_descriptor = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (root_descriptor < 0) fail_errno("SAFE_DB_OPEN_FAILED", absolute_path, "Cannot pin filesystem root");
  DatabaseState state;
  state.absolute_path = absolute_path;
  state.file_name = segments.back();
  state.path_handles.emplace_back(root_descriptor);
  for (std::size_t index = 0; index + 1 < segments.size(); ++index) {
    auto next = open_entry_at(state.path_handles.back(), segments[index]);
    if (!next) {
      std::string missing;
      for (std::size_t remaining = index; remaining + 1 < segments.size(); ++remaining) {
        if (!missing.empty()) missing += "/";
        missing += segments[remaining];
      }
      state.binding = "anchor:" + entry_info(state.path_handles.back()).identity + ";missing-parent:" + missing +
                      ";name:" + state.file_name;
      return state;
    }
    if (!next->info.directory) {
      throw SafeFsError("UNSAFE_DB_PATH", segments[index], "Database parent component is not a directory");
    }
    state.path_handles.emplace_back(std::move(next->handle));
  }
  state.parent_exists = true;
  auto file = open_entry_at(state.path_handles.back(), state.file_name);
  if (file) {
    if (!file->info.regular_file) {
      throw SafeFsError("UNSAFE_DB_PATH", state.file_name, "Database target is not a regular file");
    }
    state.file_existed = true;
    state.file.emplace(std::move(file->handle));
  }
  state.binding = database_binding(state.path_handles.back(), state.file_name, state.file);
  state.safe_path = "/proc/self/fd/" + std::to_string(state.path_handles.back().get()) + "/" + state.file_name;
  return state;
}

void pin_database_file_for_write(DatabaseState& state, bool create_if_missing) {
  if (!state.parent_exists) {
    throw SafeFsError("DB_PARENT_NOT_FOUND", state.absolute_path, "Database parent directory does not exist");
  }
  const std::optional<std::string> expected = state.file ? std::optional(entry_info(*state.file).identity) : std::nullopt;
  auto writable = open_writable_file_at(state.path_handles.back(), state.file_name);
  if (!writable) {
    if (!create_if_missing) throw SafeFsError("DB_NOT_FOUND", state.absolute_path, "Database file does not exist");
    Handle created = create_file_at(state.path_handles.back(), state.file_name);
    state.file_created = true;
    state.file.emplace(std::move(created));
  } else {
    if (expected && writable->info.identity != *expected) {
      throw SafeFsError("DB_BINDING_CHANGED", state.absolute_path, "Database identity changed before write pinning");
    }
    state.file.emplace(std::move(writable->handle));
  }
}

bool database_path_matches_state(const DatabaseState& state) {
  DatabaseState current = open_database_state(state.absolute_path);
  if (current.binding == state.binding) return true;
  if (!state.parent_exists || !current.parent_exists || !state.file) return false;
  return entry_info(current.path_handles.back()).identity == entry_info(state.path_handles.back()).identity &&
         current.file && entry_info(*current.file).identity == entry_info(*state.file).identity;
}

DatabaseAccessWitness capture_database_access_witness() {
  DatabaseAccessWitness witness;
  DIR* descriptors = opendir("/proc/self/fd");
  if (descriptors == nullptr) {
    fail_errno("DB_OPEN_PROOF_FAILED", "/proc/self/fd", "Cannot inspect process descriptors before SQLite opens");
  }
  const int scan_descriptor = dirfd(descriptors);
  try {
    while (const dirent* entry = readdir(descriptors)) {
      char* end = nullptr;
      const long descriptor = std::strtol(entry->d_name, &end, 10);
      if (end == entry->d_name || *end != '\0' || descriptor < 0 || descriptor == scan_descriptor) continue;
      struct stat stat_value {};
      if (fstat(static_cast<int>(descriptor), &stat_value) == 0 && S_ISREG(stat_value.st_mode)) {
        witness.handles.emplace_back(static_cast<std::uintptr_t>(descriptor), identity_from_stat(stat_value));
      }
    }
  } catch (...) {
    closedir(descriptors);
    throw;
  }
  if (closedir(descriptors) != 0) {
    fail_errno("DB_OPEN_PROOF_FAILED", "/proc/self/fd", "Cannot close descriptor scan after SQLite baseline");
  }
  return witness;
}

bool database_connection_matches_state(const DatabaseState& state, const DatabaseAccessWitness& witness) {
  if (!state.file) return false;
  const std::string expected_identity = entry_info(*state.file).identity;
  DIR* descriptors = opendir("/proc/self/fd");
  if (descriptors == nullptr) {
    fail_errno("DB_OPEN_PROOF_FAILED", "/proc/self/fd", "Cannot inspect SQLite process descriptors");
  }
  const int scan_descriptor = dirfd(descriptors);
  bool found_new_expected_handle = false;
  try {
    while (const dirent* entry = readdir(descriptors)) {
      char* end = nullptr;
      const long descriptor = std::strtol(entry->d_name, &end, 10);
      if (end == entry->d_name || *end != '\0' || descriptor < 0 || descriptor == scan_descriptor) continue;
      struct stat stat_value {};
      if (fstat(static_cast<int>(descriptor), &stat_value) != 0 || !S_ISREG(stat_value.st_mode)) continue;
      const std::string identity = identity_from_stat(stat_value);
      const auto baseline = std::find_if(
          witness.handles.begin(),
          witness.handles.end(),
          [&](const auto& item) {
            return item.first == static_cast<std::uintptr_t>(descriptor) && item.second == identity;
          });
      if (baseline == witness.handles.end() && identity == expected_identity) {
        found_new_expected_handle = true;
        break;
      }
    }
  } catch (...) {
    closedir(descriptors);
    throw;
  }
  if (closedir(descriptors) != 0) {
    fail_errno("DB_OPEN_PROOF_FAILED", "/proc/self/fd", "Cannot close descriptor scan after SQLite opens");
  }
  return found_new_expected_handle;
}

}  // namespace ravi::specs_safe_fs

#endif
