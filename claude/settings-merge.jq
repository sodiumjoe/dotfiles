def deepmerge($a; $b):
  if   ($a | type) == "object" and ($b | type) == "object"
  then reduce ($b | keys_unsorted[]) as $k ($a; .[$k] = deepmerge($a[$k]; $b[$k]))
  elif ($a | type) == "array" and ($b | type) == "array"
  then $a + $b
  elif $b == null
  then $a
  else $b
  end;

deepmerge(.[0]; .[1])