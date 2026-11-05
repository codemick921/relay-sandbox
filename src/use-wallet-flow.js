import {useMemo,useState} from 'react';
import {runCircleChallenge} from './circle-challenge.mjs';
import {createWalletFlow} from './wallet-flow.mjs';

export function useWalletFlow(act){
 const [note,setNote]=useState('');
 const flow=useMemo(()=>createWalletFlow({act,runChallenge:runCircleChallenge,onProblem:setNote}),[act]);
 return [flow,note];
}
