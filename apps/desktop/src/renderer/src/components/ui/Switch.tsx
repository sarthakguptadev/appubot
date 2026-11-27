import { cn } from './cn';

/** The switch in Rare UI's manner: a filled track with no border, ink when on, and a thumb that stretches under the pointer and springs across. */
export function Switch({ checked, onChange, disabled, label, className }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string; className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      data-slot="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'group/sw no-drag relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-[background-color] duration-200 ease-rare disabled:opacity-40',
        'focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--ab-bg),0_0_0_4px_var(--ab-ring)]',
        checked
          ? 'bg-primary'
          : 'bg-[color-mix(in_srgb,var(--ab-fg)_15%,transparent)] hover:bg-[color-mix(in_srgb,var(--ab-fg)_21%,transparent)]',
        className,
      )}
    >
      <span
        className={cn(
          'absolute top-1/2 left-[3px] h-4 w-4 -translate-y-1/2 rounded-full shadow-[0_1px_3px_rgba(0,0,0,.2)] transition-[translate,width] duration-(--duration-spring) ease-spring group-active/sw:w-5',
          // pressed, the thumb grows toward the middle, so its outer edge stays where it was
          checked ? 'translate-x-4 bg-primary-fg group-active/sw:translate-x-3' : 'bg-white',
        )}
      />
    </button>
  );
}
