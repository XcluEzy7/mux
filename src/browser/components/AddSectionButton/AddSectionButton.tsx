import React, { useState, useRef, useEffect } from "react";
import { Plus } from "lucide-react";
// import { Tooltip, TooltipTrigger, TooltipContent } from "../Tooltip/Tooltip";

interface AddSectionButtonProps {
  onCreateSection: (name: string) => void;
}

export const AddSectionButton: React.FC<AddSectionButtonProps> = ({ onCreateSection }) => {
  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isCreating && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isCreating]);

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (trimmed) {
      onCreateSection(trimmed);
    }
    setName("");
    setIsCreating(false);
  };

  if (isCreating) {
    return (
      <div className="flex items-center px-2 py-0.5">
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={handleSubmit}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
            if (e.key === "Escape") {
              setName("");
              setIsCreating(false);
            }
          }}
          placeholder="Section name..."
          data-testid="add-section-input"
          className="bg-background/50 text-foreground ml-6 min-w-0 flex-1 rounded border border-white/20 px-1.5 py-0.5 text-[11px] outline-none select-text"
        />
      </div>
    );
  }

  return (
    <button
      onClick={() => setIsCreating(true)}
      data-testid="add-section-button"
      className="text-muted/60 hover:text-muted flex w-full cursor-pointer items-center justify-center gap-1 border-none bg-transparent px-2 py-0.5 text-[11px] transition-colors"
    >
      <Plus size={12} />
      <span>Add section</span>
    </button>
  );
};
