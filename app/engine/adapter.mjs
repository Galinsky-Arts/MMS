import {createBuiltinEngine} from './builtin.mjs';
import {engineHealth, engineOrigin} from '../../src/engine.mjs';
import {HttpError} from '../http.mjs';

/** CompetitionEngine adapter contract. The application only talks to an engine through these
 * methods, so an external Live-Competition-Engine client can replace the built-in engine by
 * implementing the same names. `MMS_ENGINE=builtin` (default) or `MMS_ENGINE=external` with
 * `MMS_ENGINE_ORIGIN`.
 */
export const ENGINE_METHODS = Object.freeze([
 'health', 'listEvents', 'event', 'eventBySlug', 'createEvent', 'updateEvent', 'criteria', 'addCriterion', 'removeCriterion',
 'rounds', 'addRound', 'heats', 'addHeat', 'entrants', 'addEntrant', 'setEntrantStatus', 'placeEntrant', 'removeHeatEntry',
 'judges', 'assignJudge', 'removeJudge', 'isJudge', 'judgeEvents', 'heat', 'entries', 'setHeatStatus', 'timer', 'markEntry',
 'setRecording', 'scoresFor', 'submitScores', 'setVoting', 'openVotes', 'castVote', 'voteCounts', 'computeResults', 'results',
 'finalizeHeat', 'advanceRound', 'finalizeEvent', 'champions', 'publicEvent', 'entrantHistory',
]);

export function assertEngine(engine) {
 const missing = ENGINE_METHODS.filter(m => typeof engine?.[m] !== 'function');
 if (missing.length) throw new TypeError('Engine adapter is missing: ' + missing.join(', '));
 return engine;
}

/** External engine placeholder: health is probed; every operation fails closed until a client exists. */
export function createExternalEngine(origin, {fetchImpl = fetch} = {}) {
 const valid = engineOrigin(origin);
 const unavailable = async () => { throw new HttpError(503, 'The external competition engine client is not implemented for this deployment'); };
 const engine = {kind: 'external'};
 for (const m of ENGINE_METHODS) engine[m] = unavailable;
 engine.health = async () => ({...(await engineHealth(valid, {fetchImpl})), kind: 'external'});
 engine.listEvents = async () => [];
 engine.champions = async () => [];
 engine.openVotes = async () => [];
 engine.publicEvent = async () => null;
 engine.eventBySlug = async () => null;
 engine.judgeEvents = async () => [];
 engine.entrantHistory = async () => [];
 return engine;
}

export function selectEngine({kind = 'builtin', db, origin}) {
 if (kind === 'external') return assertEngine(createExternalEngine(origin));
 if (kind !== 'builtin') throw new TypeError('MMS_ENGINE must be builtin or external');
 return assertEngine(createBuiltinEngine(db));
}
