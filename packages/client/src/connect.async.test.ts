/**
 * Every RelaySession test again (connect.test.ts), with the phone on an asynchronous cipher whose answers come back after
 * random delays, as the phone's native one (expo-crypto) does: sessions must behave the same, in the same order.
 */
import { afterAll, beforeAll } from 'vitest';
import { setChannelCipher } from '@appubot/protocol';
import { asyncCipher } from './testing/asyncCipher';
import './connect.test';

beforeAll(() => setChannelCipher(asyncCipher()));
afterAll(() => setChannelCipher(null));
