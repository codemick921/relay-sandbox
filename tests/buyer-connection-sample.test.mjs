import test from 'node:test';
import assert from 'node:assert/strict';
import {createSampleConnection} from './fixtures/buyer-connection-sample.mjs';
function fixture(scenario='success'){const states=[],tasks=[];const machine=createSampleConnection({scenario,onChange:s=>states.push(s),schedule:fn=>{tasks.push(fn);return tasks.length;},cancelTimer:()=>{}});return {machine,states,tasks};}
test('sample connect, disconnect, retry, rejection, failure and expiry are explicit',()=>{
 for(const [scenario,result]of [['success','connected'],['declined','rejected'],['unavailable','error'],['expiry','connected']]){const f=fixture(scenario);f.machine.connect();assert.deepEqual(f.states,['connecting']);f.tasks[0]();assert.equal(f.states.at(-1),result);if(scenario==='expiry'){f.tasks[1]();assert.equal(f.states.at(-1),'expired');}f.machine.disconnect();assert.equal(f.states.at(-1),'disconnected');f.machine.connect();assert.equal(f.states.at(-1),'connecting');f.machine.dispose();}
});
test('cancel, scenario change and unmount ignore late sample connections even if timer cancellation loses a race',()=>{
 for(const action of ['disconnect','dispose']){const f=fixture();f.machine.connect();f.machine[action]();const before=[...f.states];f.tasks[0]();assert.deepEqual(f.states,before);}
 const f=fixture();f.machine.connect();f.machine.connect();f.tasks[0]();assert.deepEqual(f.states,['connecting','connecting']);f.tasks[1]();assert.equal(f.states.at(-1),'connected');
});
