/** A small header button; `first` and `last` join neighbours into a group. */
export function HeaderButton(props: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  danger?: boolean;
  primary?: boolean;
  first?: boolean;
  last?: boolean;
  children: string;
}) {
  const radius = props.first ? 'rounded-l-md' : props.last ? 'rounded-r-md -ml-px' : 'rounded-md';
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      className={`${radius} border px-2.5 py-1 text-xs disabled:opacity-40 ${
        props.danger
          ? 'border-neutral-800 text-neutral-400 hover:border-red-900 hover:text-red-300'
          : props.primary
            ? 'border-sky-700 bg-sky-900/40 text-sky-100 hover:border-sky-500'
            : 'border-neutral-700 text-neutral-200 hover:border-neutral-500'
      }`}
    >
      {props.children}
    </button>
  );
}
