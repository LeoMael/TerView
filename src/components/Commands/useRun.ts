// Ejecución aparte con estado (en curso / resultado / error) y cancelación desde la interfaz.
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../api/core";
import { captureExec, confirmDangerous } from "./actions";
import type { RunState } from "./parts";
import type { CommandItem } from "./state";

export function useRun(sessionId: string | null) {
  const [state, setState] = useState<RunState | null>(null);
  const token = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = useCallback(
    async (item: CommandItem, command: string) => {
      if (!sessionId) return;
      if (!(await confirmDangerous(item, command))) return;
      const my = ++token.current;
      setState({ running: true, command, result: null, error: null, startedAt: Date.now() });
      try {
        const result = await captureExec(sessionId, command);
        if (!mounted.current || my !== token.current) return;
        setState({ running: false, command, result, error: null, startedAt: 0 });
      } catch (e) {
        if (!mounted.current || my !== token.current) return;
        setState({ running: false, command, result: null, error: errorMessage(e), startedAt: 0 });
      }
    },
    [sessionId],
  );

  /** El canal remoto sigue hasta terminar o vencer su límite; aquí solo dejamos de esperar. */
  const cancel = useCallback(() => {
    token.current++;
    setState((s) => (s ? { ...s, running: false, error: "Cancelado: se dejó de esperar el resultado." } : s));
  }, []);

  const clear = useCallback(() => {
    token.current++;
    setState(null);
  }, []);

  return { state, start, cancel, clear };
}
