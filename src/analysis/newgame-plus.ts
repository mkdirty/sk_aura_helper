// New Game+ (auramz/newgame_plus.js, newgame_plus_skills.js).
//
// startNewGamePlus memorizes the switch/variable ranges registered by carryOverSwitchRange /
// carryOverVariableRange, runs DataManager.setupNewGame (a full reset, transfer to the start map)
// and restores them. Skills with <score_cost:N> can be carried over: the picker
// (showOptionsForSkills) spends score on skills Aura learned in any playthrough, and
// initCarryOverSkills (CE20 startMainGame) teaches her the selected ones. The learned and
// selected sets live in AuraMZ globals saved with the game, outside tracked state.

import type { GameData } from "../data/game-data.ts";
import { noteMeta } from "./notes.ts";

type Row = { id: number; note?: string } | null;

/** Skill ids with <score_cost> (DataManager.processCarryOverSkills). */
export const carryOverSkills = (skills: Row[]): number[] =>
  skills.filter((s): s is NonNullable<Row> => !!s && !!noteMeta(s.note ?? "").score_cost).map((s) => s.id);

export const gameCarryOverSkills = (data: GameData) => carryOverSkills(data.skills as Row[]);
