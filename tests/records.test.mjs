import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { RecordsIndex, recordsCSV, recordText } from '../src/records.ts';
import { parseCSV } from '../src/csv.ts';
const store = new Store([{name:'value',kind:'number'},{name:'note',kind:'string'}]);
store.append([9,2,null,2].map((value,index)=>({id:`id${index}`,geometry:{type:'Point',coordinates:[-1,54]},properties:{value,note:index===1?'comma,quote"':'record '+index}}))); store.finish();
test('records query intersects applied indices, uses typed stable sort with explicit nulls, and exports its exact order', async()=>{
 const records = new RecordsIndex(store);
 const query = {search:'',sort:'value',descending:false};
 const rows = await records.query(new Uint32Array([0,1,2]),query);
 assert.deepEqual([...rows],[1,0,2]);
 const csv = parseCSV(await (await recordsCSV(store,rows,['@source','@id','value','note'],'Test')).text());
 assert.equal(csv.rows.length,3); assert.equal(csv.rows[0][1],'id1'); assert.equal(csv.rows[0][3],'comma,quote"'); assert.equal(csv.rows[2][2],'');
 assert.equal(recordText(null),'null');
 records.reset(); assert.deepEqual([...(await records.query(new Uint32Array([0,3]),query))],[3,0]);
 assert.deepEqual([...(await records.query(null,{search:'id1',sort:'',descending:false}))],[1]);
 await assert.rejects(records.query(null,{search:'x',sort:'',descending:false},()=>true),/superseded/);
});
