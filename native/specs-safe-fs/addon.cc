#include <napi.h>

#include "platform.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <memory>
#include <set>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace ravi::specs_safe_fs {
namespace {

constexpr std::array<const char*, 4> kReadableNames = {"SPEC.md", "WHY.md", "RUNBOOK.md", "CHECKS.md"};

struct SnapshotEntry {
  std::string relative_path;
  EntryInfo info;
  std::optional<std::string> content;
};

struct RootState {
  Handle workspace;
  std::optional<Handle> ravi;
  std::optional<Handle> specs;
  std::string workspace_identity;
  std::string root_binding;
};

struct ExpectedFile {
  std::string name;
  std::string content;
};

struct ScanExclusion {
  std::string relative_path;
  const Handle* expected;
};

bool readable_name(const std::string& name) {
  return std::find_if(kReadableNames.begin(), kReadableNames.end(), [&](const char* allowed) { return name == allowed; }) !=
         kReadableNames.end();
}

bool safe_segment(const std::string& value, bool allow_stage = false) {
  if (value.empty() || value == "." || value == "..") return false;
  for (const unsigned char character : value) {
    const bool allowed = std::isalnum(character) || character == '.' || character == '_' || character == '-';
    if (!allowed || character == '/' || character == '\\' || character == ':' || character == 0) return false;
  }
  if (!allow_stage && !std::islower(static_cast<unsigned char>(value.front()))) return false;
  return true;
}

void require_segment(const std::string& value, bool allow_stage = false) {
  if (!safe_segment(value, allow_stage)) {
    throw SafeFsError("INVALID_RELATIVE_PATH", value, "Unsafe relative path segment");
  }
}

RootState open_root(const std::string& workspace_path) {
  RootState state;
  state.workspace = open_workspace(workspace_path);
  state.workspace_identity = entry_info(state.workspace).identity;
  auto ravi = open_entry_at(state.workspace, ".ravi");
  if (!ravi) {
    state.root_binding =
        "workspace:" + state.workspace_identity + ";ravi:missing;specs:missing";
    return state;
  }
  if (!ravi->info.directory) throw SafeFsError("UNSAFE_SPECS_ROOT", ".ravi", ".ravi is not a safe directory");
  const std::string ravi_identity = ravi->info.identity;
  state.ravi.emplace(std::move(ravi->handle));
  auto specs = open_entry_at(*state.ravi, "specs");
  if (!specs) {
    state.root_binding =
        "workspace:" + state.workspace_identity + ";ravi:" + ravi_identity + ";specs:missing";
    return state;
  }
  if (!specs->info.directory) throw SafeFsError("UNSAFE_SPECS_ROOT", ".ravi/specs", "Specs root is not a safe directory");
  state.root_binding = "workspace:" + state.workspace_identity + ";ravi:" + ravi_identity +
                       ";specs:" + specs->info.identity;
  state.specs.emplace(std::move(specs->handle));
  return state;
}

void invoke_entry_hook(const Napi::Function* hook, const std::string& relative_path) {
  if (hook == nullptr || hook->IsEmpty()) return;
  hook->Call({Napi::String::New(hook->Env(), relative_path)});
  if (hook->Env().IsExceptionPending()) {
    throw SafeFsError("TEST_HOOK_FAILED", relative_path, "Entry hook raised an exception");
  }
}

void scan_directory(
    const Handle& directory,
    const std::string& prefix,
    std::vector<SnapshotEntry>& entries,
    const Napi::Function* hook = nullptr,
    const ScanExclusion* exclusion = nullptr) {
  std::vector<std::string> names = list_directory(directory);
  std::sort(names.begin(), names.end());
  for (const std::string& name : names) {
    const std::string relative_path = prefix.empty() ? name : prefix + "/" + name;
    invoke_entry_hook(hook, relative_path);
    if (exclusion != nullptr && relative_path == exclusion->relative_path) {
      if (exclusion->expected == nullptr || !pinned_entry_still_named(directory, name, *exclusion->expected)) {
        throw SafeFsError("TREE_CHANGED_DURING_SCAN", relative_path, "Private staging directory changed during traversal");
      }
      continue;
    }
    auto opened = open_entry_at(directory, name);
    if (!opened) {
      throw SafeFsError("TREE_CHANGED_DURING_SCAN", relative_path, "Specs entry disappeared during safe traversal");
    }
    SnapshotEntry entry{relative_path, opened->info, std::nullopt};
    if (opened->info.regular_file && readable_name(name)) entry.content = read_all(opened->handle);
    entries.push_back(entry);
    if (opened->info.directory) scan_directory(opened->handle, relative_path, entries, hook, exclusion);
  }
}

std::vector<SnapshotEntry> scan_specs(
    const RootState& state,
    const Napi::Function* hook = nullptr,
    const ScanExclusion* exclusion = nullptr) {
  std::vector<SnapshotEntry> entries;
  if (state.specs) scan_directory(*state.specs, "", entries, hook, exclusion);
  return entries;
}

Napi::Object entry_to_js(Napi::Env env, const SnapshotEntry& entry) {
  Napi::Object value = Napi::Object::New(env);
  value.Set("relativePath", entry.relative_path);
  value.Set("kind", entry.info.directory ? "directory" : "file");
  value.Set("identity", entry.info.identity);
  value.Set("mtimeMs", Napi::Number::New(env, static_cast<double>(entry.info.mtime_ms)));
  value.Set("size", Napi::Number::New(env, static_cast<double>(entry.info.size)));
  if (entry.content) value.Set("content", *entry.content);
  return value;
}

Napi::Object snapshot_to_js(Napi::Env env, const RootState& state, const std::vector<SnapshotEntry>& entries) {
  Napi::Object result = Napi::Object::New(env);
  result.Set("workspaceIdentity", state.workspace_identity);
  result.Set("rootBinding", state.root_binding);
  result.Set("rootExists", state.specs.has_value());
  Napi::Array values = Napi::Array::New(env, entries.size());
  for (std::size_t index = 0; index < entries.size(); ++index) values.Set(index, entry_to_js(env, entries[index]));
  result.Set("entries", values);
  return result;
}

Napi::Value throw_safe_error(Napi::Env env, const SafeFsError& error) {
  Napi::Error js_error = Napi::Error::New(env, error.what());
  js_error.Value().Set("code", error.code);
  js_error.Value().Set("path", error.path);
  js_error.ThrowAsJavaScriptException();
  return env.Undefined();
}

std::string required_string(const Napi::Object& object, const char* key) {
  const Napi::Value value = object.Get(key);
  if (!value.IsString()) throw SafeFsError("INVALID_NATIVE_REQUEST", key, std::string(key) + " must be a string");
  return value.As<Napi::String>().Utf8Value();
}

bool optional_boolean(const Napi::Object& object, const char* key, bool fallback) {
  const Napi::Value value = object.Get(key);
  return value.IsBoolean() ? value.As<Napi::Boolean>().Value() : fallback;
}

std::vector<std::string> required_segments(const Napi::Object& object) {
  const Napi::Value value = object.Get("targetSegments");
  if (!value.IsArray()) throw SafeFsError("INVALID_NATIVE_REQUEST", "targetSegments", "targetSegments must be an array");
  const Napi::Array array = value.As<Napi::Array>();
  if (array.Length() < 1 || array.Length() > 3) {
    throw SafeFsError("INVALID_NATIVE_REQUEST", "targetSegments", "A spec target must contain one to three segments");
  }
  std::vector<std::string> segments;
  for (std::uint32_t index = 0; index < array.Length(); ++index) {
    if (!array.Get(index).IsString()) throw SafeFsError("INVALID_NATIVE_REQUEST", "targetSegments", "Invalid target segment");
    std::string segment = array.Get(index).As<Napi::String>().Utf8Value();
    require_segment(segment);
    segments.push_back(std::move(segment));
  }
  return segments;
}

std::vector<ExpectedFile> required_files(const Napi::Object& object) {
  const Napi::Value value = object.Get("files");
  if (!value.IsArray()) throw SafeFsError("INVALID_NATIVE_REQUEST", "files", "files must be an array");
  const Napi::Array array = value.As<Napi::Array>();
  if (array.Length() < 1 || array.Length() > kReadableNames.size()) {
    throw SafeFsError("INVALID_NATIVE_REQUEST", "files", "Invalid number of specs files");
  }
  std::set<std::string> unique;
  std::vector<ExpectedFile> files;
  for (std::uint32_t index = 0; index < array.Length(); ++index) {
    const Napi::Value item = array.Get(index);
    if (!item.IsObject()) throw SafeFsError("INVALID_NATIVE_REQUEST", "files", "Invalid specs file request");
    const Napi::Object file = item.As<Napi::Object>();
    std::string name = required_string(file, "name");
    if (!readable_name(name) || !unique.insert(name).second) {
      throw SafeFsError("INVALID_NATIVE_REQUEST", name, "Only unique Ravi specs files may be created");
    }
    files.push_back(ExpectedFile{std::move(name), required_string(file, "content")});
  }
  return files;
}

Handle& ensure_specs_root(RootState& state) {
  bool created_ravi = false;
  if (!state.ravi) {
    state.ravi.emplace(create_directory_at(state.workspace, ".ravi"));
    created_ravi = true;
  }
  if (!state.specs) {
    try {
      state.specs.emplace(create_directory_at(*state.ravi, "specs"));
    } catch (...) {
      if (created_ravi && !remove_empty_directory_at(state.workspace, ".ravi", *state.ravi)) {
        throw SafeFsError("ROLLBACK_FAILED", ".ravi", "Cannot roll back the empty Ravi directory after specs-root failure");
      }
      throw;
    }
  }
  return *state.specs;
}

std::optional<OpenedEntry> descend_directory(const Handle& parent, const std::string& segment) {
  auto child = open_entry_at(parent, segment);
  if (child && !child->info.directory) {
    throw SafeFsError("UNSAFE_ENTRY", segment, "Spec path component is not a directory");
  }
  return child;
}

Handle open_or_create_parent(Handle& specs, const std::vector<std::string>& segments, bool require_ancestors) {
  RawHandle duplicated = kInvalidHandle;
#ifdef _WIN32
  HANDLE duplicate = INVALID_HANDLE_VALUE;
  if (!DuplicateHandle(
          GetCurrentProcess(), reinterpret_cast<HANDLE>(specs.get()), GetCurrentProcess(), &duplicate, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
    throw SafeFsError("SAFE_OPEN_FAILED", "", "Cannot duplicate pinned specs root");
  }
  duplicated = reinterpret_cast<RawHandle>(duplicate);
#else
  duplicated = dup(specs.get());
  if (duplicated < 0) throw SafeFsError("SAFE_OPEN_FAILED", "", "Cannot duplicate pinned specs root");
#endif
  Handle current(duplicated);
  for (std::size_t index = 0; index + 1 < segments.size(); ++index) {
    auto next = descend_directory(current, segments[index]);
    if (!next) {
      if (require_ancestors) {
        throw SafeFsError("SPEC_ANCESTORS_MISSING", segments[index], "Required ancestor spec directory is absent");
      }
      current = create_directory_at(current, segments[index]);
    } else {
      current = std::move(next->handle);
    }
    if (require_ancestors) {
      auto spec = open_entry_at(current, "SPEC.md");
      if (!spec || !spec->info.regular_file) {
        throw SafeFsError("SPEC_ANCESTORS_MISSING", segments[index], "Required ancestor SPEC.md is absent");
      }
      (void)read_all(spec->handle);
    }
  }
  return current;
}

std::vector<SnapshotEntry> scan_target(const Handle& target) {
  std::vector<SnapshotEntry> entries;
  scan_directory(target, "", entries);
  return entries;
}

bool exact_target(const std::vector<SnapshotEntry>& entries, const std::vector<ExpectedFile>& expected) {
  if (entries.size() != expected.size()) return false;
  for (const ExpectedFile& file : expected) {
    const auto found = std::find_if(entries.begin(), entries.end(), [&](const SnapshotEntry& entry) {
      return entry.relative_path == file.name && entry.info.regular_file && entry.content && *entry.content == file.content;
    });
    if (found == entries.end()) return false;
  }
  return true;
}

bool contains_spec(const std::vector<SnapshotEntry>& entries) {
  return std::any_of(entries.begin(), entries.end(), [](const SnapshotEntry& entry) {
    return entry.relative_path == "SPEC.md";
  });
}

Napi::Object creation_result(Napi::Env env, const char* status, const Handle& target) {
  const std::vector<SnapshotEntry> entries = scan_target(target);
  Napi::Object result = Napi::Object::New(env);
  result.Set("status", status);
  result.Set("targetIdentity", entry_info(target).identity);
  Napi::Array values = Napi::Array::New(env, entries.size());
  for (std::size_t index = 0; index < entries.size(); ++index) values.Set(index, entry_to_js(env, entries[index]));
  result.Set("entries", values);
  return result;
}

Napi::Value snapshot_binding(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  try {
    if (info.Length() < 1 || !info[0].IsString()) {
      throw SafeFsError("INVALID_NATIVE_REQUEST", "workspacePath", "snapshot requires an absolute workspace path");
    }
    const std::string workspace_path = info[0].As<Napi::String>().Utf8Value();
    RootState state = open_root(workspace_path);
    std::optional<Napi::Function> hook;
    if (info.Length() > 1 && info[1].IsFunction()) hook.emplace(info[1].As<Napi::Function>());
    const std::vector<SnapshotEntry> entries = scan_specs(state, hook ? &*hook : nullptr);
    return snapshot_to_js(env, state, entries);
  } catch (const SafeFsError& error) {
    return throw_safe_error(env, error);
  } catch (const std::exception& error) {
    return throw_safe_error(env, SafeFsError("NATIVE_SAFE_FS_FAILED", "", error.what()));
  }
}

Napi::Value create_spec(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  try {
    if (info.Length() < 1 || !info[0].IsObject()) {
      throw SafeFsError("INVALID_NATIVE_REQUEST", "request", "createSpec requires an operation request");
    }
    const Napi::Object request = info[0].As<Napi::Object>();
    const std::string workspace_path = required_string(request, "workspacePath");
    const std::string expected_workspace = required_string(request, "expectedWorkspaceIdentity");
    const std::string expected_root = required_string(request, "expectedRootBinding");
    const std::vector<std::string> segments = required_segments(request);
    const std::vector<ExpectedFile> files = required_files(request);
    const bool require_ancestors = optional_boolean(request, "requireAncestors", false);
    const std::string existing_directory = required_string(request, "existingDirectory");
    const std::string existing = required_string(request, "existing");
    std::string staging_name = required_string(request, "stagingName");
    require_segment(staging_name, true);

    RootState state = open_root(workspace_path);
    if (state.workspace_identity != expected_workspace || state.root_binding != expected_root) {
      throw SafeFsError("TREE_BINDING_CHANGED", ".ravi/specs", "Specs tree binding changed before the native operation");
    }
    (void)scan_specs(state);
    Handle& specs = ensure_specs_root(state);
    Handle parent = open_or_create_parent(specs, segments, require_ancestors);
    const std::string& target_name = segments.back();
    auto existing_target = open_entry_at(parent, target_name);
    if (existing_target) {
      if (!existing_target->info.directory) {
        throw SafeFsError("SPEC_TARGET_CONFLICT", target_name, "Spec target is not a safe directory");
      }
      const std::vector<SnapshotEntry> entries = scan_target(existing_target->handle);
      if (existing == "noop" && exact_target(entries, files)) return creation_result(env, "noop", existing_target->handle);
      if (contains_spec(entries)) throw SafeFsError("SPEC_ALREADY_EXISTS", target_name, "Spec already exists");
      if (existing_directory != "populate") {
        throw SafeFsError("SPEC_TARGET_CONFLICT", target_name, "Spec target directory already exists without SPEC.md");
      }
      for (const ExpectedFile& file : files) {
        auto current = open_writable_file_at(existing_target->handle, file.name);
        if (current) {
          if (!current->info.regular_file) throw SafeFsError("UNSAFE_ENTRY", file.name, "Legacy target entry is not a regular file");
          replace_contents(current->handle, file.content);
          flush_handle(current->handle);
        } else {
          Handle created = create_file_at(existing_target->handle, file.name);
          write_all(created, file.content);
          flush_handle(created);
        }
      }
      return creation_result(env, "created", existing_target->handle);
    }

    Handle staging = create_movable_directory_at(parent, staging_name);
    const std::string original_recovery_name = staging_name + ".original";
    const std::string promotion_rollback_name = staging_name + ".rollback";
    bool promoted = false;
    try {
      for (const ExpectedFile& file : files) {
        Handle created = create_file_at(staging, file.name);
        write_all(created, file.content);
        flush_handle(created);
      }
      const Napi::Value hook_value = request.Get("beforePromote");
      if (hook_value.IsFunction()) {
        const Napi::Value hook_result =
            hook_value.As<Napi::Function>().Call({Napi::String::New(env, required_string(request, "stagingPath"))});
        if (env.IsExceptionPending()) throw SafeFsError("TEST_HOOK_FAILED", staging_name, "Promotion hook raised an exception");
        if (hook_result.IsBoolean() && !hook_result.As<Napi::Boolean>().Value()) {
          throw SafeFsError("TEST_HOOK_FAILED", staging_name, "Promotion hook rejected the operation");
        }
      }
      std::string staging_relative_path;
      for (std::size_t index = 0; index + 1 < segments.size(); ++index) {
        if (!staging_relative_path.empty()) staging_relative_path += "/";
        staging_relative_path += segments[index];
      }
      if (!staging_relative_path.empty()) staging_relative_path += "/";
      staging_relative_path += staging_name;
      const ScanExclusion exclusion{staging_relative_path, &staging};
      (void)scan_specs(state, nullptr, &exclusion);
      if (!exact_target(scan_target(staging), files)) {
        throw SafeFsError("SAFE_STAGE_CHANGED", staging_name, "Private staging contents changed before promotion");
      }
      if (require_ancestors) {
        Handle checked_parent = open_or_create_parent(specs, segments, true);
        if (entry_info(checked_parent).identity != entry_info(parent).identity) {
          throw SafeFsError("TREE_BINDING_CHANGED", target_name, "Spec parent identity changed before promotion");
        }
      }
      if (open_entry_at(parent, target_name)) {
        throw SafeFsError("SAFE_PROMOTION_FAILED", target_name, "Spec target appeared before promotion");
      }
      const Napi::Value native_hook_value = request.Get("beforeNativePromote");
      std::function<void()> native_hook;
      if (native_hook_value.IsFunction()) {
        native_hook = [&]() {
          const Napi::Value hook_result = native_hook_value.As<Napi::Function>().Call(
              {Napi::String::New(env, required_string(request, "stagingPath")),
               Napi::String::New(env, required_string(request, "originalRecoveryPath"))});
          if (env.IsExceptionPending()) {
            throw SafeFsError("TEST_HOOK_FAILED", staging_name, "Native promotion hook raised an exception");
          }
          if (hook_result.IsBoolean() && !hook_result.As<Napi::Boolean>().Value()) {
            throw SafeFsError("TEST_HOOK_FAILED", staging_name, "Native promotion hook rejected the operation");
          }
        };
      }
      promote_directory_no_replace(
          parent, staging_name, staging, target_name, promotion_rollback_name, native_hook);
      promoted = true;
      return creation_result(env, "created", staging);
    } catch (...) {
      if (!promoted) {
        const bool removed_at_stage = remove_private_tree(parent, staging_name, staging);
        const bool removed_at_recovery =
            removed_at_stage ? false : remove_private_tree(parent, original_recovery_name, staging);
        if (!removed_at_stage && !removed_at_recovery) {
          throw SafeFsError(
              "STAGING_CLEANUP_FAILED", staging_name, "Pinned staging directory could not be found for cleanup");
        }
      }
      throw;
    }
  } catch (const SafeFsError& error) {
    return throw_safe_error(env, error);
  } catch (const std::exception& error) {
    return throw_safe_error(env, SafeFsError("NATIVE_SAFE_FS_FAILED", "", error.what()));
  }
}

Napi::Object database_state_to_js(Napi::Env env, const DatabaseState& state) {
  Napi::Object result = Napi::Object::New(env);
  result.Set("binding", state.binding);
  result.Set("parentExists", state.parent_exists);
  result.Set("fileExists", state.file_existed);
  return result;
}

Napi::Value snapshot_database(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  try {
    if (info.Length() < 1 || !info[0].IsString()) {
      throw SafeFsError("INVALID_NATIVE_REQUEST", "databasePath", "Database snapshot requires an absolute path");
    }
    return database_state_to_js(env, open_database_state(info[0].As<Napi::String>().Utf8Value()));
  } catch (const SafeFsError& error) {
    return throw_safe_error(env, error);
  } catch (const std::exception& error) {
    return throw_safe_error(env, SafeFsError("NATIVE_SAFE_FS_FAILED", "", error.what()));
  }
}

Napi::Value with_database(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  try {
    if (info.Length() < 1 || !info[0].IsObject()) {
      throw SafeFsError("INVALID_NATIVE_REQUEST", "request", "withDatabase requires an operation request");
    }
    const Napi::Object request = info[0].As<Napi::Object>();
    const std::string database_path = required_string(request, "databasePath");
    const std::string expected_binding = required_string(request, "expectedBinding");
    const bool write = optional_boolean(request, "write", false);
    const bool create = optional_boolean(request, "create", false);
    const Napi::Value callback_value = request.Get("callback");
    if (!callback_value.IsFunction()) {
      throw SafeFsError("INVALID_NATIVE_REQUEST", "callback", "withDatabase callback must be a function");
    }

    DatabaseState state = open_database_state(database_path);
    if (state.binding != expected_binding) {
      throw SafeFsError("DB_BINDING_CHANGED", database_path, "Database binding changed before access");
    }
    const Napi::Value hook_value = request.Get("beforeOpen");
    if (hook_value.IsFunction()) {
      hook_value.As<Napi::Function>().Call({});
      if (env.IsExceptionPending()) {
        throw SafeFsError("TEST_HOOK_FAILED", database_path, "Database-open hook raised an exception");
      }
    }
    if (!database_path_matches_state(state)) {
      throw SafeFsError("DB_BINDING_CHANGED", database_path, "Database path changed before access pinning");
    }
    if (write) {
      pin_database_file_for_write(state, create);
    } else if (!state.file) {
      throw SafeFsError("DB_NOT_FOUND", database_path, "Database file does not exist");
    }
    if (!database_path_matches_state(state)) {
      throw SafeFsError("DB_BINDING_CHANGED", database_path, "Database target changed before callback");
    }

    const Napi::Value before_callback_value = request.Get("beforeCallback");
    if (before_callback_value.IsFunction()) {
      before_callback_value.As<Napi::Function>().Call({Napi::String::New(env, state.safe_path)});
      if (env.IsExceptionPending()) {
        throw SafeFsError("TEST_HOOK_FAILED", database_path, "Database-callback hook raised an exception");
      }
    }
    const DatabaseAccessWitness access_witness = capture_database_access_witness();
    bool database_open_confirmed = false;
    const Napi::Function confirm_database_open = Napi::Function::New(
        env,
        [&](const Napi::CallbackInfo& callback_info) -> Napi::Value {
          try {
            if (!database_connection_matches_state(state, access_witness)) {
              throw SafeFsError(
                  "DB_OPEN_IDENTITY_MISMATCH",
                  database_path,
                  "SQLite did not open the database file pinned by the approved plan");
            }
            database_open_confirmed = true;
            return callback_info.Env().Undefined();
          } catch (const SafeFsError& error) {
            return throw_safe_error(callback_info.Env(), error);
          } catch (const std::exception& error) {
            return throw_safe_error(
                callback_info.Env(), SafeFsError("DB_OPEN_PROOF_FAILED", database_path, error.what()));
          }
        });

    const Napi::Value callback_result = callback_value.As<Napi::Function>().Call(
        {Napi::String::New(env, state.safe_path), confirm_database_open});
    if (env.IsExceptionPending()) return env.Undefined();
    if (!database_open_confirmed) {
      throw SafeFsError(
          "DB_OPEN_NOT_CONFIRMED", database_path, "Database callback did not confirm its opened SQLite connection");
    }
    if (!database_path_matches_state(state)) {
      throw SafeFsError(
          "DB_BINDING_CHANGED_AFTER_WRITE", database_path, "Database path changed while the pinned operation ran");
    }
    return callback_result;
  } catch (const SafeFsError& error) {
    return throw_safe_error(env, error);
  } catch (const std::exception& error) {
    return throw_safe_error(env, SafeFsError("NATIVE_SAFE_FS_FAILED", "", error.what()));
  }
}

Napi::Object initialize(Napi::Env env, Napi::Object exports) {
  exports.Set("snapshot", Napi::Function::New(env, snapshot_binding));
  exports.Set("createSpec", Napi::Function::New(env, create_spec));
  exports.Set("snapshotDatabase", Napi::Function::New(env, snapshot_database));
  exports.Set("withDatabase", Napi::Function::New(env, with_database));
  exports.Set("implementation", "node-api-handles-v2");
  return exports;
}

}  // namespace
}  // namespace ravi::specs_safe_fs

Napi::Object InitializeRaviSpecsSafeFs(Napi::Env env, Napi::Object exports) {
  return ravi::specs_safe_fs::initialize(env, exports);
}

NODE_API_MODULE(ravi_specs_safe_fs, InitializeRaviSpecsSafeFs)
