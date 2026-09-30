import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateDubbingCredits } from '../src/lib/pricing.ts';
import { STAGE5_TTS_MODEL_ELEVEN_V3, STAGE5_TTS_MODEL_ELEVEN_V4 } from '../src/lib/model-catalog.ts';
test('new v4 requests use normal pricing while old v3 reservations retain their original rate', () => {
  const v4=estimateDubbingCredits({characters:1000,model:STAGE5_TTS_MODEL_ELEVEN_V4});
  const v3=estimateDubbingCredits({characters:1000,model:STAGE5_TTS_MODEL_ELEVEN_V3});
  assert.equal(Math.round(v4.usdEstimate*100),8); assert.equal(Math.round(v3.usdEstimate*100),18);
  assert.ok(v4.credits < v3.credits);
});
