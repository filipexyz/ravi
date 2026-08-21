#ifdef _WIN32

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>

#include "platform.h"

#include <algorithm>
#include <array>
#include <iomanip>
#include <memory>
#include <sstream>

namespace ravi::specs_safe_fs {
namespace {

using NtCreateFileFn = NTSTATUS(NTAPI*)(
    PHANDLE,
    ACCESS_MASK,
    POBJECT_ATTRIBUTES,
    PIO_STATUS_BLOCK,
    PLARGE_INTEGER,
    ULONG,
    ULONG,
    ULONG,
    ULONG,
    PVOID,
    ULONG);
using NtSetInformationFileFn = NTSTATUS(NTAPI*)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);

struct NativeFileRenameInformation {
  BOOLEAN replace_if_exists;
  HANDLE root_directory;
  ULONG file_name_length;
  WCHAR file_name[1];
};

constexpr NTSTATUS kStatusObjectNameNotFound = static_cast<NTSTATUS>(0xC0000034L);
constexpr NTSTATUS kStatusObjectPathNotFound = static_cast<NTSTATUS>(0xC000003AL);
constexpr NTSTATUS kStatusNoSuchFile = static_cast<NTSTATUS>(0xC000000FL);
constexpr ULONG kFileOpenReparsePoint = 0x00200000;
constexpr ULONG kFileDirectoryFile = 0x00000001;
constexpr ULONG kFileNonDirectoryFile = 0x00000040;
constexpr ULONG kFileSynchronousIoNonAlert = 0x00000020;
constexpr ULONG kFileOpen = 0x00000001;
constexpr ULONG kFileCreate = 0x00000002;

NtCreateFileFn nt_create_file() {
  static NtCreateFileFn function = reinterpret_cast<NtCreateFileFn>(
      GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile"));
  if (function == nullptr) {
    throw SafeFsError("UNSUPPORTED_FILESYSTEM_PRIMITIVE", "", "NtCreateFile is unavailable");
  }
  return function;
}

NtSetInformationFileFn nt_set_information_file() {
  static NtSetInformationFileFn function = reinterpret_cast<NtSetInformationFileFn>(
      GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtSetInformationFile"));
  if (function == nullptr) {
    throw SafeFsError("UNSUPPORTED_FILESYSTEM_PRIMITIVE", "", "NtSetInformationFile is unavailable");
  }
  return function;
}

std::wstring widen(const std::string& value) {
  if (value.empty()) return {};
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (size <= 0) throw SafeFsError("INVALID_PATH_ENCODING", value, "Path is not valid UTF-8");
  std::wstring result(static_cast<std::size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size);
  return result;
}

std::string narrow(const wchar_t* value, std::size_t length) {
  if (length == 0) return {};
  const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, static_cast<int>(length), nullptr, 0, nullptr, nullptr);
  if (size <= 0) throw SafeFsError("INVALID_PATH_ENCODING", "", "Filesystem name is not valid Unicode");
  std::string result(static_cast<std::size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, static_cast<int>(length), result.data(), size, nullptr, nullptr);
  return result;
}

std::string windows_message(DWORD code) {
  wchar_t* buffer = nullptr;
  const DWORD size = FormatMessageW(
      FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
      nullptr,
      code,
      0,
      reinterpret_cast<wchar_t*>(&buffer),
      0,
      nullptr);
  std::string message = size == 0 ? ("Windows error " + std::to_string(code)) : narrow(buffer, size);
  if (buffer != nullptr) LocalFree(buffer);
  while (!message.empty() && (message.back() == '\r' || message.back() == '\n' || message.back() == ' ')) message.pop_back();
  return message;
}

[[noreturn]] void fail_win32(const std::string& code, const std::string& path, const std::string& action) {
  throw SafeFsError(code, path, action + ": " + windows_message(GetLastError()));
}

EntryInfo info_from_handle(HANDLE handle) {
  BY_HANDLE_FILE_INFORMATION basic {};
  if (!GetFileInformationByHandle(handle, &basic)) fail_win32("SAFE_STAT_FAILED", "", "Cannot inspect pinned entry");
  if ((basic.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    throw SafeFsError("UNSAFE_LINK", "", "Reparse points are not allowed in the specs tree");
  }
  const bool directory = (basic.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  if (!directory && basic.nNumberOfLinks != 1) {
    throw SafeFsError("UNSAFE_HARD_LINK", "", "Hard-linked files are not allowed in the specs tree");
  }
  FILE_ID_INFO id {};
  if (!GetFileInformationByHandleEx(handle, FileIdInfo, &id, sizeof(id))) {
    fail_win32("SAFE_STAT_FAILED", "", "Cannot read pinned entry identity");
  }
  std::ostringstream identity;
  identity << std::hex << id.VolumeSerialNumber << ":";
  for (const unsigned char byte : id.FileId.Identifier) identity << std::setw(2) << std::setfill('0') << static_cast<int>(byte);
  ULARGE_INTEGER modified {};
  modified.LowPart = basic.ftLastWriteTime.dwLowDateTime;
  modified.HighPart = basic.ftLastWriteTime.dwHighDateTime;
  ULARGE_INTEGER size {};
  size.LowPart = basic.nFileSizeLow;
  size.HighPart = basic.nFileSizeHigh;
  return EntryInfo{
      directory,
      !directory,
      modified.QuadPart < 116444736000000000ULL ? 0 : (modified.QuadPart - 116444736000000000ULL) / 10000ULL,
      size.QuadPart,
      identity.str()};
}

std::optional<Handle> nt_open_relative(
    const Handle& parent,
    const std::string& name,
    ACCESS_MASK access,
    ULONG disposition,
    ULONG options,
    ULONG attributes,
    ULONG share = FILE_SHARE_READ | FILE_SHARE_WRITE) {
  std::wstring wide_name = widen(name);
  UNICODE_STRING unicode {};
  unicode.Buffer = wide_name.data();
  unicode.Length = static_cast<USHORT>(wide_name.size() * sizeof(wchar_t));
  unicode.MaximumLength = unicode.Length;
  OBJECT_ATTRIBUTES object {};
  InitializeObjectAttributes(&object, &unicode, OBJ_CASE_INSENSITIVE, reinterpret_cast<HANDLE>(parent.get()), nullptr);
  IO_STATUS_BLOCK status_block {};
  HANDLE result = INVALID_HANDLE_VALUE;
  const NTSTATUS status = nt_create_file()(
      &result,
      access,
      &object,
      &status_block,
      nullptr,
      attributes,
      share,
      disposition,
      options | kFileOpenReparsePoint | kFileSynchronousIoNonAlert,
      nullptr,
      0);
  if (status == kStatusObjectNameNotFound || status == kStatusObjectPathNotFound || status == kStatusNoSuchFile) {
    return std::nullopt;
  }
  if (status < 0) {
    SetLastError(RtlNtStatusToDosError(status));
    fail_win32("SAFE_OPEN_FAILED", name, "Cannot open specs entry relative to its pinned parent");
  }
  return Handle(reinterpret_cast<RawHandle>(result));
}

}  // namespace

Handle::~Handle() { reset(); }

void Handle::reset(RawHandle value) {
  if (valid()) CloseHandle(reinterpret_cast<HANDLE>(value_));
  value_ = value;
}

Handle open_workspace(const std::string& absolute_path) {
  const std::wstring path = widen(absolute_path);
  HANDLE handle = CreateFileW(
      path.c_str(),
      FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr);
  if (handle == INVALID_HANDLE_VALUE) fail_win32("WORKSPACE_OPEN_FAILED", absolute_path, "Cannot open workspace");
  Handle result(reinterpret_cast<RawHandle>(handle));
  const EntryInfo info = entry_info(result);
  if (!info.directory) throw SafeFsError("WORKSPACE_OPEN_FAILED", absolute_path, "Workspace is not a directory");
  return result;
}

std::optional<OpenedEntry> open_entry_at(const Handle& parent, const std::string& name) {
  auto handle = nt_open_relative(
      parent,
      name,
      FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      kFileOpen,
      0,
      FILE_ATTRIBUTE_NORMAL);
  if (!handle) return std::nullopt;
  EntryInfo info = entry_info(*handle);
  return OpenedEntry{std::move(*handle), std::move(info)};
}

std::optional<OpenedEntry> open_writable_file_at(const Handle& parent, const std::string& name) {
  auto handle = nt_open_relative(
      parent,
      name,
      FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE | DELETE,
      kFileOpen,
      kFileNonDirectoryFile,
      FILE_ATTRIBUTE_NORMAL);
  if (!handle) return std::nullopt;
  EntryInfo info = entry_info(*handle);
  if (!info.regular_file) throw SafeFsError("UNSAFE_ENTRY", name, "Writable specs entry is not a regular file");
  return OpenedEntry{std::move(*handle), std::move(info)};
}

bool pinned_entry_still_named(const Handle& parent, const std::string& name, const Handle& expected) {
  auto handle = nt_open_relative(
      parent,
      name,
      FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      kFileOpen,
      0,
      FILE_ATTRIBUTE_NORMAL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
  if (!handle) return false;
  return entry_info(*handle).identity == entry_info(expected).identity;
}

Handle create_directory_at(const Handle& parent, const std::string& name) {
  auto handle = nt_open_relative(
      parent,
      name,
      FILE_LIST_DIRECTORY | FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      kFileCreate,
      kFileDirectoryFile,
      FILE_ATTRIBUTE_DIRECTORY);
  if (!handle) throw SafeFsError("SAFE_CREATE_FAILED", name, "Cannot create specs directory");
  const EntryInfo info = entry_info(*handle);
  if (!info.directory) throw SafeFsError("SAFE_CREATE_FAILED", name, "Created specs entry is not a directory");
  return std::move(*handle);
}

Handle create_movable_directory_at(const Handle& parent, const std::string& name) {
  auto handle = nt_open_relative(
      parent,
      name,
      FILE_LIST_DIRECTORY | FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE | DELETE,
      kFileCreate,
      kFileDirectoryFile,
      FILE_ATTRIBUTE_DIRECTORY);
  if (!handle) throw SafeFsError("SAFE_CREATE_FAILED", name, "Cannot create movable specs directory");
  const EntryInfo info = entry_info(*handle);
  if (!info.directory) throw SafeFsError("SAFE_CREATE_FAILED", name, "Created specs entry is not a directory");
  return std::move(*handle);
}

Handle create_file_at(const Handle& parent, const std::string& name) {
  auto handle = nt_open_relative(
      parent,
      name,
      FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE | DELETE,
      kFileCreate,
      kFileNonDirectoryFile,
      FILE_ATTRIBUTE_NORMAL);
  if (!handle) throw SafeFsError("SAFE_CREATE_FAILED", name, "Cannot create specs file");
  const EntryInfo info = entry_info(*handle);
  if (!info.regular_file) throw SafeFsError("SAFE_CREATE_FAILED", name, "Created specs entry is not a regular file");
  return std::move(*handle);
}

std::vector<std::string> list_directory(const Handle& directory) {
  std::vector<std::string> names;
  std::array<unsigned char, 64 * 1024> buffer {};
  bool restart = true;
  while (true) {
    const FILE_INFO_BY_HANDLE_CLASS info_class = restart ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo;
    if (!GetFileInformationByHandleEx(
            reinterpret_cast<HANDLE>(directory.get()), info_class, buffer.data(), static_cast<DWORD>(buffer.size()))) {
      const DWORD error = GetLastError();
      if (error == ERROR_NO_MORE_FILES) break;
      fail_win32("SAFE_ENUMERATION_FAILED", "", "Cannot enumerate complete specs directory");
    }
    restart = false;
    unsigned char* current = buffer.data();
    while (true) {
      auto* entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(current);
      const std::string name = narrow(entry->FileName, entry->FileNameLength / sizeof(wchar_t));
      if (name != "." && name != "..") names.push_back(name);
      if (entry->NextEntryOffset == 0) break;
      current += entry->NextEntryOffset;
    }
  }
  return names;
}

EntryInfo entry_info(const Handle& handle) { return info_from_handle(reinterpret_cast<HANDLE>(handle.get())); }

std::string read_all(const Handle& file) {
  const EntryInfo info = entry_info(file);
  if (!info.regular_file) throw SafeFsError("UNSAFE_ENTRY", info.identity, "Only regular specs files can be read");
  LARGE_INTEGER zero {};
  if (!SetFilePointerEx(reinterpret_cast<HANDLE>(file.get()), zero, nullptr, FILE_BEGIN)) {
    fail_win32("SAFE_READ_FAILED", info.identity, "Cannot seek specs file");
  }
  std::string result(static_cast<std::size_t>(info.size), '\0');
  std::size_t offset = 0;
  while (offset < result.size()) {
    DWORD count = 0;
    const DWORD requested = static_cast<DWORD>(std::min<std::size_t>(result.size() - offset, 1024 * 1024));
    if (!ReadFile(reinterpret_cast<HANDLE>(file.get()), result.data() + offset, requested, &count, nullptr)) {
      fail_win32("SAFE_READ_FAILED", info.identity, "Cannot read specs file");
    }
    if (count == 0) break;
    offset += count;
  }
  result.resize(offset);
  return result;
}

void replace_contents(const Handle& file, const std::string& content) {
  LARGE_INTEGER zero {};
  if (!SetFilePointerEx(reinterpret_cast<HANDLE>(file.get()), zero, nullptr, FILE_BEGIN) ||
      !SetEndOfFile(reinterpret_cast<HANDLE>(file.get()))) {
    fail_win32("SAFE_WRITE_FAILED", "", "Cannot truncate pinned specs file");
  }
  write_all(file, content);
}

void write_all(const Handle& file, const std::string& content) {
  std::size_t offset = 0;
  while (offset < content.size()) {
    DWORD count = 0;
    const DWORD requested = static_cast<DWORD>(std::min<std::size_t>(content.size() - offset, 1024 * 1024));
    if (!WriteFile(reinterpret_cast<HANDLE>(file.get()), content.data() + offset, requested, &count, nullptr)) {
      fail_win32("SAFE_WRITE_FAILED", "", "Cannot write pinned specs file");
    }
    offset += count;
  }
}

void flush_handle(const Handle& handle) {
  if (!FlushFileBuffers(reinterpret_cast<HANDLE>(handle.get()))) {
    fail_win32("SAFE_FLUSH_FAILED", "", "Cannot flush pinned specs entry");
  }
}

void promote_directory_no_replace(
    const Handle& parent,
    const std::string&,
  const Handle& staging,
  const std::string& target_name) {
  const std::wstring wide_name = widen(target_name);
  const std::size_t bytes = offsetof(NativeFileRenameInformation, file_name) + wide_name.size() * sizeof(wchar_t);
  std::vector<unsigned char> storage(bytes, 0);
  auto* rename = reinterpret_cast<NativeFileRenameInformation*>(storage.data());
  rename->replace_if_exists = FALSE;
  rename->root_directory = reinterpret_cast<HANDLE>(parent.get());
  rename->file_name_length = static_cast<ULONG>(wide_name.size() * sizeof(wchar_t));
  std::copy(wide_name.begin(), wide_name.end(), rename->file_name);
  IO_STATUS_BLOCK status_block {};
  const NTSTATUS status = nt_set_information_file()(
      reinterpret_cast<HANDLE>(staging.get()),
      &status_block,
      rename,
      static_cast<ULONG>(storage.size()),
      FileRenameInformation);
  if (status < 0) {
    SetLastError(RtlNtStatusToDosError(status));
    fail_win32("SAFE_PROMOTION_FAILED", target_name, "Cannot promote specs directory without replacement");
  }
  if (!pinned_entry_still_named(parent, target_name, staging)) {
    throw SafeFsError("SAFE_PROMOTION_FAILED", target_name, "Promoted target identity does not match pinned staging");
  }
}

void remove_private_tree(const Handle& parent, const std::string& name, const Handle& expected_directory) noexcept {
  try {
    if (!pinned_entry_still_named(parent, name, expected_directory)) return;
    for (const std::string& child_name : list_directory(expected_directory)) {
      auto child = open_writable_file_at(expected_directory, child_name);
      if (!child || child->info.directory) continue;
      FILE_DISPOSITION_INFO disposition {TRUE};
      SetFileInformationByHandle(
          reinterpret_cast<HANDLE>(child->handle.get()), FileDispositionInfo, &disposition, sizeof(disposition));
    }
    FILE_DISPOSITION_INFO disposition {TRUE};
    SetFileInformationByHandle(
        reinterpret_cast<HANDLE>(expected_directory.get()), FileDispositionInfo, &disposition, sizeof(disposition));
  } catch (...) {
  }
}

}  // namespace ravi::specs_safe_fs

#endif
