import { createContext, useContext, type ComponentProps } from "react";

export const GitBusyContext = createContext(false);

export function OperationButton({ disabled, ...props }: ComponentProps<"button">) {
  const busy = useContext(GitBusyContext);
  return <button {...props} disabled={busy || disabled} />;
}
