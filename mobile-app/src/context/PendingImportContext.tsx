/**
 * PendingImportContext
 * ====================
 * Holds an EPUB that arrived via iOS "Open in EbookVoice" (CFBundleDocumentTypes
 * handoff) until the navigator is ready to consume it.
 *
 * Why a context instead of route params: the file can arrive at any moment
 * (cold launch, warm foreground) and we may need to cross the auth boundary
 * before the upload screen exists in the navigation stack. Stashing it here
 * lets MainNavigator pick it up the moment `user` becomes truthy, with no
 * coupling between the Linking handler and the nav state machine.
 *
 * Lifecycle:
 *   1. App.tsx's Linking handler calls setPending({ uri, name, mimeType, size }).
 *   2. MainNavigator sees user + pending → navigates to Upload with
 *      preselectedFile, then clearPending().
 *   3. If never consumed (e.g. user closes app on Login screen), it sits in
 *      memory until the process dies — intentional. No AsyncStorage persistence
 *      because the iOS inbox file URI becomes invalid after the next launch.
 */

import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';

export interface PendingEpubFile {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
}

interface PendingImportContextType {
  pendingFile: PendingEpubFile | null;
  setPending: (file: PendingEpubFile) => void;
  clearPending: () => void;
}

const PendingImportContext = createContext<PendingImportContextType | undefined>(undefined);

export const PendingImportProvider = ({ children }: { children: ReactNode }) => {
  const [pendingFile, setPendingFile] = useState<PendingEpubFile | null>(null);

  const setPending = useCallback((file: PendingEpubFile) => {
    setPendingFile(file);
  }, []);

  const clearPending = useCallback(() => {
    setPendingFile(null);
  }, []);

  return (
    <PendingImportContext.Provider value={{ pendingFile, setPending, clearPending }}>
      {children}
    </PendingImportContext.Provider>
  );
};

export const usePendingImport = () => {
  const ctx = useContext(PendingImportContext);
  if (!ctx) throw new Error('usePendingImport must be used within PendingImportProvider');
  return ctx;
};
