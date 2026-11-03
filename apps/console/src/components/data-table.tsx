"use client";

import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { useOrgRouter } from "@/lib/org-href";
import { useState } from "react";

export type DataTableProps<T> = {
  data: T[];
  columns: ColumnDef<T>[];
  getRowHref?: (row: T) => string;
  empty?: string;
};

export function DataTable<T>({ data, columns, getRowHref, empty = "No records found." }: DataTableProps<T>) {
  const router = useOrgRouter();
  const [sorting, setSorting] = useState<SortingState>([]);
  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (data.length === 0) {
    return <div className="empty">{empty}</div>;
  }

  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th key={header.id} style={{ width: header.getSize() }}>
                  {header.isPlaceholder ? null : (
                    <button onClick={header.column.getToggleSortingHandler()} type="button">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </button>
                  )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => {
            const href = getRowHref?.(row.original);
            return (
              <tr
                className={href ? "row-click" : undefined}
                key={row.id}
                onClick={href ? () => router.push(href) : undefined}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

