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

#include <array>
#include <cstring>
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

EntryInfo info_from_stat(const struct stat& stat_value) {
  EntryInfo info;
  info.directory = S_ISDIR(stat_value.st_mode);
  info.regular_file = S_ISREG(stat_value.st_mode);
  info.mtime_ms = static_cast<std::uint64_t>(stat_value.st_mtim.tv_sec) * 1000ULL +
                  static_cast<std::uint64_t>(stat_value.st_mtim.tv_nsec / 1000000ULL);
  info.size = static_cast<std::uint64_t>(stat_value.st_size);
  info.identity = std::to_string(static_cast<std::uint64_t>(stat_value.st_dev)) + ":" +
                  std::to_string(static_cast<std::uint64_t>(stat_value.st_ino));
  if (info.regular_file && stat_value.st_nlink != 1) {
    throw SafeFsError("UNSAFE_HARD_LINK", info.identity, "Hard-linked files are not allowed in the specs tree");
  }
  if (!info.directory && !info.regular_file) {
    throw SafeFsError("UNSAFE_ENTRY", info.identity, "Non-regular entries are not allowed in the specs tree");
  }
  return info;
}

bool same_identity(const EntryInfo& left, const EntryInfo& right) { return left.identity == right.identity; }

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
  auto opened = open_entry_at(parent, name);
  if (!opened || !opened->info.directory) {
    throw SafeFsError("SAFE_CREATE_FAILED", name, "Created specs directory could not be pinned");
  }
  return std::move(opened->handle);
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
    const std::string& target_name) {
  const EntryInfo expected = entry_info(staging);
  if (syscall(SYS_renameat2, parent.get(), staging_name.c_str(), parent.get(), target_name.c_str(), RENAME_NOREPLACE) !=
      0) {
    if (errno == ENOSYS || errno == EINVAL || errno == EOPNOTSUPP) {
      fail_errno("UNSUPPORTED_FILESYSTEM_PRIMITIVE", target_name, "renameat2 RENAME_NOREPLACE is required");
    }
    fail_errno("SAFE_PROMOTION_FAILED", target_name, "Cannot promote specs directory without replacement");
  }
  auto promoted = open_entry_at(parent, target_name);
  if (!promoted || !promoted->info.directory || !same_identity(expected, promoted->info)) {
    if (promoted) unlinkat(parent.get(), target_name.c_str(), promoted->info.directory ? AT_REMOVEDIR : 0);
    throw SafeFsError("PROMOTION_IDENTITY_CHANGED", target_name, "Promoted specs directory identity changed concurrently");
  }
}

void remove_private_tree(const Handle& parent, const std::string& name, const Handle& expected_directory) noexcept {
  try {
    const EntryInfo expected = entry_info(expected_directory);
    auto current = open_entry_at(parent, name);
    if (!current || !current->info.directory || !same_identity(expected, current->info)) return;
    for (const std::string& child_name : list_directory(current->handle)) {
      unlinkat(current->handle.get(), child_name.c_str(), 0);
    }
    unlinkat(parent.get(), name.c_str(), AT_REMOVEDIR);
  } catch (...) {
  }
}

}  // namespace ravi::specs_safe_fs

#endif
