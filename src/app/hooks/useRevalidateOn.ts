"use client";

import { useEffect, useRef } from "react";

/** Read a list again each time `revision` moves on (not on mount). */
export function useRevalidateOn(revision: number, mutate: () => unknown) {
  const mutateRef = useRef(mutate);
  mutateRef.current = mutate;
  const seen = useRef(revision);
  useEffect(() => {
    if (seen.current === revision) return;
    seen.current = revision;
    void mutateRef.current();
  }, [revision]);
}
