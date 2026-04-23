import { useCallback, useEffect, useState } from "react";
import {
  type FileNode,
  type Project,
  getProject,
  languageFromName,
  uid,
  upsertProject,
} from "@/lib/projects";

export function useProject(projectId: string | undefined) {
  const [project, setProject] = useState<Project | null>(null);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!projectId) {
      setLoaded(true);
      return;
    }
    const p = getProject(projectId);
    if (p) {
      setProject(p);
      setActiveFileId(p.files[0]?.id ?? null);
    }
    setLoaded(true);
  }, [projectId]);

  const persist = useCallback((next: Project) => {
    setProject(next);
    upsertProject(next);
  }, []);

  const updateFile = useCallback(
    (fileId: string, content: string) => {
      if (!project) return;
      const next: Project = {
        ...project,
        files: project.files.map((f) => (f.id === fileId ? { ...f, content } : f)),
      };
      persist(next);
    },
    [project, persist],
  );

  const createFile = useCallback(
    (name: string) => {
      if (!project) return;
      if (project.files.some((f) => f.name === name)) return;
      const file: FileNode = {
        id: uid(),
        name,
        content: "",
        language: languageFromName(name),
      };
      const next: Project = { ...project, files: [...project.files, file] };
      persist(next);
      setActiveFileId(file.id);
    },
    [project, persist],
  );

  const deleteFile = useCallback(
    (fileId: string) => {
      if (!project) return;
      const next: Project = { ...project, files: project.files.filter((f) => f.id !== fileId) };
      persist(next);
      if (activeFileId === fileId) setActiveFileId(next.files[0]?.id ?? null);
    },
    [project, persist, activeFileId],
  );

  const renameFile = useCallback(
    (fileId: string, newName: string) => {
      if (!project) return;
      if (project.files.some((f) => f.name === newName && f.id !== fileId)) return;
      const next: Project = {
        ...project,
        files: project.files.map((f) =>
          f.id === fileId ? { ...f, name: newName, language: languageFromName(newName) } : f,
        ),
      };
      persist(next);
    },
    [project, persist],
  );

  const renameProject = useCallback(
    (name: string) => {
      if (!project) return;
      persist({ ...project, name });
    },
    [project, persist],
  );

  return {
    project,
    activeFileId,
    setActiveFileId,
    updateFile,
    createFile,
    deleteFile,
    renameFile,
    renameProject,
  };
}
