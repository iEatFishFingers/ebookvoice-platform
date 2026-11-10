-- Migration 006: conversion_tasks.language
-- Run via: Supabase SQL Editor
-- Safe to re-run (uses IF NOT EXISTS guards).
--
-- Adds the ISO 639-1 book language to the in-flight task row so the worker
-- can stamp it on the audiobook record after conversion completes. The
-- /convert-chapters endpoint passes `language` through the task dict, and
-- the task table needs to accept it for the same PGRST204 reason migration
-- 004 had to add `is_retry`.
--
-- Backend uses a defensive insert/retry in task_manager.create_task, so the
-- service keeps running before this migration is applied — but tasks will
-- never carry a language code through to the audiobook row until you run it.

ALTER TABLE conversion_tasks
  ADD COLUMN IF NOT EXISTS language TEXT;
