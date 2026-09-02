#!/bin/sh
# Throwaway: five alternating reps of fix-vs-control so box drift hits both arms equally.
cd /home/anshtyagi/Documents/pixel-artgame/scripts/spike/framebudget
export PW_HOME=/home/anshtyagi/.npm/_npx/9833c18b2d85bc59
for r in 0 1 2 3 4; do
  uptime
  DIR=dist3    ARM=now REPS=1 CASES=$PWD/cases34.json      OUT=/dev/null PORT=8770 node drive34.mjs
  DIR=dist3ctl ARM=ctl REPS=1 CASES=$PWD/cases34-cpu6.json OUT=/dev/null PORT=8771 node drive34.mjs
done
uptime
