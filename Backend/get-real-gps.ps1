# Real device location via Windows Location API
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Devices.Geolocation.Geolocator,Windows.Devices.Geolocation,ContentType=WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
$loc = [Windows.Devices.Geolocation.Geolocator]::new()
$loc.DesiredAccuracyInMeters = 100
$op = $loc.GetGeopositionAsync()
$pos = Await $op ([Windows.Devices.Geolocation.Geoposition])
$c = $pos.Coordinate.Point.Position
Write-Output ("{0},{1},{2}" -f $c.Latitude, $c.Longitude, $pos.Coordinate.Accuracy)
