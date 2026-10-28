package main

func activeRDP(states []uint32, protocol func(int) (uint16, error)) *bool {
	unknown := false
	for i, state := range states {
		if state != 0 {
			continue
		}
		kind, err := protocol(i)
		if err != nil {
			unknown = true
			continue
		}
		if kind == 2 {
			result := true
			return &result
		}
	}
	if unknown {
		return nil
	}
	result := false
	return &result
}
