#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace ravi::specs_safe_fs {

class SafeFsError final : public std::runtime_error {
 public:
  SafeFsError(std::string code, std::string path, std::string message)
      : std::runtime_error(std::move(message)), code(std::move(code)), path(std::move(path)) {}

  std::string code;
  std::string path;
};

struct EntryInfo {
  bool directory = false;
  bool regular_file = false;
  std::uint64_t mtime_ms = 0;
  std::uint64_t size = 0;
  std::string identity;
};

#ifdef _WIN32
using RawHandle = void*;
inline constexpr RawHandle kInvalidHandle = nullptr;
#else
using RawHandle = int;
inline constexpr RawHandle kInvalidHandle = -1;
#endif

class Handle final {
 public:
  Handle() = default;
  explicit Handle(RawHandle value) : value_(value) {}
  ~Handle();

  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;

  Handle(Handle&& other) noexcept : value_(other.release()) {}
  Handle& operator=(Handle&& other) noexcept {
    if (this != &other) reset(other.release());
    return *this;
  }

  [[nodiscard]] bool valid() const { return value_ != kInvalidHandle; }
  [[nodiscard]] RawHandle get() const { return value_; }
  RawHandle release() {
    const RawHandle value = value_;
    value_ = kInvalidHandle;
    return value;
  }
  void reset(RawHandle value = kInvalidHandle);

 private:
  RawHandle value_ = kInvalidHandle;
};

struct OpenedEntry {
  Handle handle;
  EntryInfo info;
};

struct DatabaseState {
  std::vector<Handle> path_handles;
  std::optional<Handle> file;
  std::string absolute_path;
  std::string file_name;
  std::string binding;
  std::string safe_path;
  bool parent_exists = false;
  bool file_existed = false;
  bool file_created = false;
};

struct DatabaseAccessWitness {
  std::vector<std::pair<std::uintptr_t, std::string>> handles;
};

Handle open_workspace(const std::string& absolute_path);
std::optional<OpenedEntry> open_entry_at(const Handle& parent, const std::string& name);
std::optional<OpenedEntry> open_writable_file_at(const Handle& parent, const std::string& name);
bool pinned_entry_still_named(const Handle& parent, const std::string& name, const Handle& expected);
Handle create_directory_at(const Handle& parent, const std::string& name);
Handle create_movable_directory_at(const Handle& parent, const std::string& name);
Handle create_file_at(const Handle& parent, const std::string& name);
std::vector<std::string> list_directory(const Handle& directory);
EntryInfo entry_info(const Handle& handle);
std::string read_all(const Handle& file);
void replace_contents(const Handle& file, const std::string& content);
void write_all(const Handle& file, const std::string& content);
void flush_handle(const Handle& handle);
void promote_directory_no_replace(
    const Handle& parent,
    const std::string& staging_name,
    const Handle& staging,
    const std::string& target_name,
    const std::string& recovery_name,
    const std::function<void()>& immediately_before_rename);
bool remove_private_tree(const Handle& parent, const std::string& name, const Handle& expected_directory);
bool remove_empty_directory_at(const Handle& parent, const std::string& name, const Handle& expected_directory);

DatabaseState open_database_state(const std::string& absolute_path);
void pin_database_file_for_write(DatabaseState& state, bool create_if_missing);
bool database_path_matches_state(const DatabaseState& state);
DatabaseAccessWitness capture_database_access_witness();
bool database_connection_matches_state(const DatabaseState& state, const DatabaseAccessWitness& witness);

}  // namespace ravi::specs_safe_fs
