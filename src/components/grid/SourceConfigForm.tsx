"use client";

import { Input } from "@/components/ui/input";
import { ENTITY_FIELD, placeholderFor } from "@/lib/sourceConfig";
import type { SourceMeta } from "@/lib/types";
import { cn } from "cn";

export function SourceConfigForm({
  source,
  values,
  onChange,
}: {
  source: SourceMeta;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <>
      {source.configFields.map((field) =>
        field.key === ENTITY_FIELD ? (
          <div key={field.key}>
            <label className="mb-1 block text-xs font-medium">{field.label}</label>
            <div className="flex gap-1.5">
              {(["company", "person"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => onChange(ENTITY_FIELD, option)}
                  className={cn(
                    "rounded-md border px-2 py-1 text-xs",
                    values[ENTITY_FIELD] === option ? "border-foreground bg-accent" : "hover:bg-accent",
                  )}
                >
                  {option === "company" ? "companies" : "people"}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div key={field.key}>
            <label className="mb-1 block text-xs font-medium">{field.label}</label>
            <Input
              value={values[field.key] ?? ""}
              placeholder={placeholderFor(field.key, field.type)}
              onChange={(e) => onChange(field.key, e.target.value)}
            />
          </div>
        ),
      )}
    </>
  );
}
