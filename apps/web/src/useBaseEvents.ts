import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { CLIENT_ID } from "./api";

interface ChangeEvent {
  scope: "records" | "schema" | "views" | "comments";
  baseId: string;
  tableId?: string;
  recordId?: string;
  clientId?: string;
  byMe: boolean;
}

/**
 * Listens for changes other people (or your other tabs) make in this base and refreshes what's
 * on screen. Returns whether the live connection is up.
 */
export function useBaseEvents(baseId: string | undefined) {
  const qc = useQueryClient();
  const [live, setLive] = useState(false);
  const timer = useRef<number>();
  const pending = useRef(new Set<string>());

  useEffect(() => {
    if (!baseId) return;
    const es = new EventSource(`/api/bases/${baseId}/events`, { withCredentials: true });
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false); // the browser reconnects by itself

    // Batch bursts of events (e.g. a CSV import) into one refresh.
    const flush = () => {
      const keys = [...pending.current];
      pending.current.clear();
      for (const k of keys) qc.invalidateQueries({ queryKey: JSON.parse(k) });
    };
    const queue = (key: unknown[]) => {
      pending.current.add(JSON.stringify(key));
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, 250);
    };

    es.onmessage = (msg) => {
      let e: ChangeEvent;
      try { e = JSON.parse(msg.data); } catch { return; }
      if (e.clientId && e.clientId === CLIENT_ID) return; // our own change; already on screen
      switch (e.scope) {
        case "records":
          queue(["viewRecords"]);
          if (e.recordId) queue(["recordHistory", e.recordId]);
          break;
        case "comments":
          if (e.recordId) queue(["recordComments", e.recordId]);
          queue(["attComments"]);
          break;
        case "views":
          queue(["table", e.tableId]);
          queue(["viewRecords"]);
          break;
        case "schema":
          queue(["base", baseId]);
          queue(["table"]);
          queue(["viewRecords"]);
          break;
      }
    };
    return () => {
      es.close();
      window.clearTimeout(timer.current);
      setLive(false);
    };
  }, [baseId, qc]);

  return live;
}
