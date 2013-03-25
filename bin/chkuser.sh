#!/bin/bash
for INFRA in 'aws' 'ap01.aws' 'eu01.aws' 'hp' 'rs'
  do
    af target bhvu5gugln.$INFRA.af.cm
    af login joe@appfog.com --password $AFPW
    af -u $1 info
  done
af target api.appfog.com
