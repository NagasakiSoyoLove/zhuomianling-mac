import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";

export interface PetPackageChoiceOption {
  value: string;
  label: string;
}

export function PetPackageChoice({
  value,
  options,
  onChange,
  disabled = false,
  placeholder = "请选择",
  ariaLabel,
  searchable = false
}: {
  value: string;
  options: PetPackageChoiceOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel: string;
  searchable?: boolean;
}): JSX.Element {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();
  const selected = options.find((option) => option.value === value);
  const filteredOptions = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    if (!searchable || !keyword || selected?.label === query) return options;
    return options.filter((option) => `${option.label}\n${option.value}`.toLocaleLowerCase().includes(keyword));
  }, [options, query, searchable, selected?.label]);

  useEffect(() => {
    if (!open) setQuery(selected?.label ?? "");
  }, [open, selected?.label]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = (): void => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const openAbove = below < 150 && above > below;
      const maxHeight = Math.max(96, Math.min(240, openAbove ? above : below));
      setMenuStyle({
        position: "fixed",
        left: rect.left,
        top: openAbove ? undefined : rect.bottom + 7,
        bottom: openAbove ? window.innerHeight - rect.top + 7 : undefined,
        width: rect.width,
        maxHeight
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  const openMenu = (): void => {
    if (disabled) return;
    const selectedIndex = filteredOptions.findIndex((option) => option.value === value);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  };

  const selectOption = (option: PetPackageChoiceOption): void => {
    onChange(option.value);
    setQuery(option.label);
    setOpen(false);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) { openMenu(); return; }
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => (index + direction + filteredOptions.length) % Math.max(filteredOptions.length, 1));
      return;
    }
    if (event.key === "Enter" && open && filteredOptions[activeIndex]) {
      event.preventDefault();
      selectOption(filteredOptions[activeIndex]);
    }
  };

  const menu = open ? createPortal(
    <div className="packageChoiceMenu" id={listboxId} role="listbox" aria-label={ariaLabel} ref={menuRef} style={menuStyle}>
      {filteredOptions.length ? filteredOptions.map((option, index) => {
        const isSelected = option.value === value;
        return <button id={`${listboxId}-${index}`} key={option.value} type="button" role="option" aria-selected={isSelected} className={`packageChoiceOption${isSelected ? " selected" : ""}${index === activeIndex ? " active" : ""}`} onPointerMove={() => setActiveIndex(index)} onClick={() => selectOption(option)}><span>{option.label}</span>{isSelected ? <Check size={16} aria-hidden="true" /> : null}</button>;
      }) : <div className="packageChoiceEmpty">没有匹配的模型</div>}
    </div>,
    document.body
  ) : null;

  return <div className={`packageChoice${open ? " open" : ""}${searchable ? " searchable" : ""}`} ref={rootRef}>
    {searchable ? <div className="packageChoiceInputWrap"><Search size={17} aria-hidden="true" /><input role="combobox" aria-label={ariaLabel} aria-autocomplete="list" aria-expanded={open} aria-controls={listboxId} aria-activedescendant={open && filteredOptions[activeIndex] ? `${listboxId}-${activeIndex}` : undefined} disabled={disabled} value={open ? query : selected?.label ?? ""} placeholder={placeholder} onFocus={openMenu} onClick={openMenu} onChange={(event) => { setQuery(event.target.value); onChange(""); setActiveIndex(0); setOpen(true); }} onKeyDown={onKeyDown} /><ChevronDown size={16} aria-hidden="true" className="packageChoiceChevron" /></div> : <button className="packageChoiceButton" type="button" disabled={disabled} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={listboxId} onClick={() => open ? setOpen(false) : openMenu()} onKeyDown={onKeyDown}><span className={selected ? "" : "placeholder"}>{selected?.label ?? placeholder}</span><ChevronDown size={16} aria-hidden="true" /></button>}
    {menu}
  </div>;
}
