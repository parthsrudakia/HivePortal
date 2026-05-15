import { useEffect, useRef } from "react";
import { toast } from "sonner";

/**
 * Watches a useActionState() state and fires a sonner toast when the form
 * transitions from pending→idle. Successful "no error" returns show
 * `successMessage`; returning `{ error }` shows that as an error toast.
 *
 * Usage:
 *   const [state, action, pending] = useActionState(myAction, undefined);
 *   useFormToast({ pending, state, successMessage: "Tenant added" });
 */
export function useFormToast({
  pending,
  state,
  successMessage,
}: {
  pending: boolean;
  state: { error?: string } | undefined;
  successMessage: string;
}) {
  const submittedRef = useRef(false);
  useEffect(() => {
    if (pending) {
      submittedRef.current = true;
      return;
    }
    if (!submittedRef.current) return;
    submittedRef.current = false;
    if (state?.error) {
      toast.error(state.error);
    } else {
      toast.success(successMessage);
    }
  }, [pending, state, successMessage]);
}
