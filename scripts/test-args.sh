#!/usr/bin/env bash
echo "Args: $@"
if [[ $# -eq 0 ]]; then
  echo "No args"
else
  echo "Has args"
fi